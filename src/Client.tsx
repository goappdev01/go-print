// Vista del cliente (móvil): elige archivos, ve el precio y los envía directo al locutorio.
import { useEffect, useRef, useState } from "react";
import { joinRoom, type Signal } from "./signaling";
import { PeerLink, sendFiles } from "./rtc";
import { countPages } from "./pages";
import {
  ACCEPTED, MAX_FILE_BYTES, euros, priceOf, randomId,
  type ColorMode, type DataControl, type PrintRequest, type SignalMessage, type Tariff,
} from "./protocol";

type Phase = "searching" | "notfound" | "ready" | "waiting" | "rejected" | "sending" | "done" | "error";
type Picked = { file: File; pages: number | null; error?: string };

export function Client({ room }: { room: string }) {
  const me = useRef(randomId(12)).current;
  const signal = useRef<Signal | null>(null);
  const link = useRef<PeerLink | null>(null);
  const [phase, setPhase] = useState<Phase>("searching");
  const [station, setStation] = useState("");
  const [tariff, setTariff] = useState<Tariff | null>(null);
  const [picked, setPicked] = useState<Picked[]>([]);
  const [copies, setCopies] = useState(1);
  const [color, setColor] = useState<ColorMode>("bn");
  const [progress, setProgress] = useState(0);
  const [message, setMessage] = useState("");
  const pickedRef = useRef(picked);
  pickedRef.current = picked;
  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  useEffect(() => {
    const s = joinRoom(room, (m) => void onSignal(m));
    signal.current = s;
    let tries = 0;
    const hello = () => s.send({ t: "hello", from: me, name: "Cliente" });
    hello();
    const timer = setInterval(() => {
      if (phaseRef.current !== "searching") return clearInterval(timer);
      if (++tries >= 4) { setPhase("notfound"); clearInterval(timer); } else hello();
    }, 2500);
    return () => { clearInterval(timer); s.close(); link.current?.close(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room]);

  async function onSignal(m: SignalMessage) {
    if (m.t === "closed") { if (phaseRef.current !== "done") { setPhase("error"); setMessage("El locutorio cerró la estación."); } return; }
    if (!("to" in m) || m.to !== me) return;
    switch (m.t) {
      case "welcome":
        setStation(m.station); setTariff(m.tariff);
        if (phaseRef.current === "searching" || phaseRef.current === "notfound") setPhase("ready");
        break;
      case "reject":
        setPhase("rejected"); setMessage(m.reason);
        break;
      case "accept":
        await startTransfer();
        break;
      case "answer":
        await link.current?.setRemote(m.sdp);
        break;
      case "ice":
        await link.current?.addIce(m.candidate);
        break;
    }
  }

  async function startTransfer() {
    setPhase("sending"); setProgress(0);
    const s = signal.current!;
    const l = new PeerLink((candidate) => s.send({ t: "ice", from: me, candidate }));
    link.current = l;
    const dc = l.pc.createDataChannel("files", { ordered: true });
    const files = pickedRef.current.map((p) => p.file);
    let acks = 0;
    dc.onmessage = (e) => {
      if (typeof e.data !== "string") return;
      const msg = JSON.parse(e.data) as DataControl;
      if (msg.t !== "ack") return;
      if (!msg.ok) { setPhase("error"); setMessage("Un archivo llegó dañado. Inténtalo otra vez."); return; }
      if (++acks === files.length) { setPhase("done"); setTimeout(() => l.close(), 1000); }
    };
    dc.onopen = () => {
      sendFiles(l, dc, files, (sent, total) => setProgress(sent / total)).catch(() => {
        setPhase("error"); setMessage("Se cortó la conexión. No bloquees el móvil durante el envío.");
      });
    };
    l.pc.onconnectionstatechange = () => {
      if (l.pc.connectionState === "failed" && phaseRef.current === "sending") {
        setPhase("error"); setMessage("No se pudo conectar con el locutorio. Conéctate al wifi del local e inténtalo de nuevo.");
      }
    };
    const offer = await l.pc.createOffer();
    await l.pc.setLocalDescription(offer);
    s.send({ t: "offer", from: me, sdp: offer });
  }

  async function onPick(list: FileList | null) {
    if (!list) return;
    const added: Picked[] = Array.from(list).map((file) => ({
      file,
      pages: null,
      error: !ACCEPTED.includes(file.type) ? "Formato no admitido (usa PDF o imagen)"
        : file.size > MAX_FILE_BYTES ? "Máximo 100 MB" : undefined,
    }));
    setPicked((p) => [...p, ...added]);
    for (const item of added) {
      if (item.error) continue;
      const pages = await countPages(item.file).catch(() => null);
      setPicked((p) => p.map((x) => x === item ? { ...x, pages, error: pages === null ? "No se pudo leer el PDF" : undefined } : x));
    }
  }

  const valid = picked.filter((p) => !p.error && p.pages);
  const pageSum = valid.reduce((n, p) => n + (p.pages ?? 0), 0);
  const quote = tariff ? priceOf(pageSum, copies, color, tariff) : null;
  const counting = picked.some((p) => !p.error && p.pages === null);

  function send() {
    if (!quote || !valid.length) return;
    setPicked(valid);
    const request: PrintRequest = {
      files: valid.map((p) => ({ name: p.file.name, size: p.file.size, mime: p.file.type, pages: p.pages! })),
      copies, color, pages: quote.pages, price: quote.price,
    };
    signal.current!.send({ t: "request", from: me, request });
    setPhase("waiting");
  }

  function reset() {
    link.current?.close(); link.current = null;
    setPicked([]); setCopies(1); setProgress(0); setMessage(""); setPhase("ready");
  }

  return (
    <main className="client">
      <header className="topbar">
        <strong>GO Print</strong>
        {station && <span className="muted">{station}</span>}
      </header>

      {phase === "searching" && <div className="card center"><div className="spinner" /><p>Conectando con el locutorio…</p></div>}

      {phase === "notfound" && (
        <div className="card center">
          <h2>No encontramos el locutorio</h2>
          <p>Pide al dependiente que abra la estación de recepción y vuelve a escanear el código QR.</p>
          <button className="btn" onClick={() => location.reload()}>Reintentar</button>
        </div>
      )}

      {phase === "ready" && tariff && (
        <>
          <div className="card">
            <h2>1. Elige tus archivos</h2>
            <label className="drop">
              <input type="file" multiple accept={ACCEPTED.join(",")} onChange={(e) => { void onPick(e.target.files); e.target.value = ""; }} />
              <span>Toca para elegir PDF o fotos</span>
            </label>
            {picked.length > 0 && (
              <ul className="files">
                {picked.map((p, i) => (
                  <li key={i} className={p.error ? "bad" : ""}>
                    <span className="name">{p.file.name}</span>
                    <span className="muted">{p.error ?? (p.pages === null ? "contando…" : `${p.pages} pág.`)}</span>
                    <button className="link" aria-label="Quitar" onClick={() => setPicked((x) => x.filter((_, j) => j !== i))}>✕</button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="card">
            <h2>2. Opciones</h2>
            <div className="row">
              <span>Copias</span>
              <div className="stepper">
                <button onClick={() => setCopies((c) => Math.max(1, c - 1))}>−</button>
                <span>{copies}</span>
                <button onClick={() => setCopies((c) => Math.min(50, c + 1))}>+</button>
              </div>
            </div>
            <div className="segmented">
              <button className={color === "bn" ? "on" : ""} onClick={() => setColor("bn")}>Blanco y negro · {euros(tariff.bn)}/pág</button>
              <button className={color === "color" ? "on" : ""} onClick={() => setColor("color")}>Color · {euros(tariff.color)}/pág</button>
            </div>
          </div>

          <div className="summary">
            <div><span className="muted">{quote?.pages ?? 0} páginas</span><strong>{euros(quote?.price ?? 0)}</strong></div>
            <button className="btn" disabled={!valid.length || counting} onClick={send}>Enviar al locutorio</button>
            <p className="tiny">Se paga en el mostrador. El archivo va directo al locutorio, cifrado, y no se guarda en ningún servidor.</p>
          </div>
        </>
      )}

      {phase === "waiting" && <div className="card center"><div className="spinner" /><h2>Esperando al dependiente…</h2><p>En cuanto acepte, tu archivo se enviará.</p></div>}

      {phase === "sending" && (
        <div className="card center">
          <h2>Enviando…</h2>
          <div className="bar"><div style={{ width: `${Math.round(progress * 100)}%` }} /></div>
          <p><strong>No bloquees el móvil ni cierres esta pantalla.</strong></p>
        </div>
      )}

      {phase === "done" && (
        <div className="card center">
          <div className="check">✓</div>
          <h2>¡Recibido!</h2>
          <p>Recoge tus copias en el mostrador.{quote && <> Importe: <strong>{euros(quote.price)}</strong></>}</p>
          <button className="btn secondary" onClick={reset}>Enviar otro archivo</button>
        </div>
      )}

      {(phase === "rejected" || phase === "error") && (
        <div className="card center">
          <h2>{phase === "rejected" ? "Envío rechazado" : "Algo salió mal"}</h2>
          <p>{message}</p>
          <button className="btn" onClick={reset}>Volver a intentarlo</button>
        </div>
      )}
    </main>
  );
}
