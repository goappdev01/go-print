// Estación de recepción (PC del locutorio): muestra el QR, recibe archivos en memoria y los imprime.
import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { joinRoom, signalingMode, type Signal } from "./signaling";
import { PeerLink, receiveFiles, type ReceivedFile } from "./rtc";
import { countPages } from "./pages";
import { euros, priceOf, randomId, type PrintRequest, type SignalMessage, type Tariff } from "./protocol";

type Status = "connected" | "pending" | "receiving" | "ready" | "printed" | "error";
type Received = ReceivedFile & { url: string; pages: number | null };
interface Session {
  id: string;
  name: string;
  status: Status;
  request?: PrintRequest;
  price?: number; // calculado aquí con la tarifa del locutorio, no la del cliente
  progress: number;
  files: Received[];
  route?: string;
  error?: string;
  at: number;
}

const AUTO_WIPE_MS = 15 * 60 * 1000;
const DEFAULT_TARIFF: Tariff = { bn: 0.1, color: 0.3 };

function load<T>(key: string, fallback: T): T {
  try { const v = localStorage.getItem(key); return v ? (JSON.parse(v) as T) : fallback; } catch { return fallback; }
}
function save(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* sin almacenamiento */ }
}

function validRequest(r: PrintRequest | undefined): r is PrintRequest {
  return !!r && Array.isArray(r.files) && r.files.length > 0 && r.files.length <= 20 &&
    Number.isInteger(r.copies) && r.copies >= 1 && r.copies <= 50 && (r.color === "bn" || r.color === "color") &&
    r.files.every((f) => Number.isInteger(f.pages) && f.pages > 0 && f.pages < 5000);
}

export function Station() {
  const [room, setRoom] = useState(() => sessionStorage.getItem("gp-room") ?? randomId());
  const [name, setName] = useState(() => load("gp-station", "Mi locutorio"));
  const [tariff, setTariff] = useState<Tariff>(() => load("gp-tariff", DEFAULT_TARIFF));
  const [qr, setQr] = useState("");
  const [sessions, setSessions] = useState<Session[]>([]);
  const [settings, setSettings] = useState(false);
  const signal = useRef<Signal | null>(null);
  const links = useRef(new Map<string, PeerLink>());
  const config = useRef({ name, tariff });
  config.current = { name, tariff };
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;

  const clientUrl = `${location.origin}/?s=${room}`;

  const patch = (id: string, change: Partial<Session> | ((s: Session) => Partial<Session>)) =>
    setSessions((list) => list.map((s) => (s.id === id ? { ...s, ...(typeof change === "function" ? change(s) : change) } : s)));

  useEffect(() => { save("gp-station", name); }, [name]);
  useEffect(() => { save("gp-tariff", tariff); }, [tariff]);

  useEffect(() => {
    sessionStorage.setItem("gp-room", room);
    void QRCode.toDataURL(clientUrl, { margin: 1, width: 320, errorCorrectionLevel: "M" }).then(setQr);
    const s = joinRoom(room, (m) => void onSignal(m));
    signal.current = s;
    return () => { s.send({ t: "closed", station: room }); s.close(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room]);

  // Borrado automático de trabajos antiguos y limpieza al cerrar la pestaña.
  useEffect(() => {
    const timer = setInterval(() => {
      for (const s of sessionsRef.current) if (Date.now() - s.at > AUTO_WIPE_MS) wipe(s.id);
    }, 30_000);
    const bye = () => signal.current?.send({ t: "closed", station: room });
    addEventListener("pagehide", bye);
    return () => { clearInterval(timer); removeEventListener("pagehide", bye); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room]);

  async function onSignal(m: SignalMessage) {
    if (!("from" in m) || !m.from) return;
    const from = m.from;
    const known = sessionsRef.current.find((s) => s.id === from);
    switch (m.t) {
      case "hello": {
        const { name: station, tariff } = config.current;
        signal.current!.send({ t: "welcome", to: from, station, tariff });
        if (!known) {
          const fresh: Session = { id: from, name: String(m.name).slice(0, 40), status: "connected", progress: 0, files: [], at: Date.now() };
          sessionsRef.current = [fresh, ...sessionsRef.current];
          setSessions((l) => (l.some((s) => s.id === from) ? l : [fresh, ...l]));
        }
        break;
      }
      case "request": {
        if (!known) return;
        if (!validRequest(m.request)) { signal.current!.send({ t: "reject", to: from, reason: "Pedido no válido." }); return; }
        const pages = m.request.files.reduce((n, f) => n + f.pages, 0);
        const { price } = priceOf(pages, m.request.copies, m.request.color, config.current.tariff);
        known.files.forEach((f) => URL.revokeObjectURL(f.url));
        links.current.get(from)?.close();
        links.current.delete(from);
        patch(from, { status: "pending", request: m.request, price, at: Date.now(), files: [], progress: 0, error: undefined });
        notify(`Nuevo envío de ${known.name}`);
        break;
      }
      case "offer": {
        const link = links.current.get(from);
        if (!link) return;
        await link.setRemote(m.sdp);
        const answer = await link.pc.createAnswer();
        await link.pc.setLocalDescription(answer);
        signal.current!.send({ t: "answer", to: from, sdp: answer });
        break;
      }
      case "ice":
        await links.current.get(from)?.addIce(m.candidate);
        break;
    }
  }

  function accept(s: Session) {
    const link = new PeerLink((candidate) => signal.current!.send({ t: "ice", to: s.id, candidate }));
    links.current.set(s.id, link);
    const totalBytes = s.request!.files.reduce((n, f) => n + f.size, 0) || 1;
    link.pc.ondatachannel = ({ channel }) => {
      receiveFiles(channel, {
        onProgress: (bytes) => patch(s.id, { progress: bytes / totalBytes }),
        onFile: (f) => {
          const item: Received = { ...f, url: URL.createObjectURL(f.blob), pages: null };
          patch(s.id, (cur) => ({ files: [...cur.files, item] }));
          // Comprobamos aquí las páginas: no nos fiamos del recuento del móvil.
          void countPages(f.blob).catch(() => null).then((pages) =>
            patch(s.id, (cur) => ({ files: cur.files.map((x) => (x.url === item.url ? { ...x, pages } : x)) })));
        },
        onDone: async () => {
          patch(s.id, { status: "ready", progress: 1, route: await link.route() });
          setTimeout(() => link.close(), 1500);
        },
        onError: (error) => patch(s.id, { status: "error", error }),
      });
    };
    link.pc.onconnectionstatechange = () => {
      if (link.pc.connectionState === "failed") patch(s.id, { status: "error", error: "No se pudo establecer la conexión" });
    };
    patch(s.id, { status: "receiving", progress: 0 });
    signal.current!.send({ t: "accept", to: s.id });
  }

  function reject(s: Session) {
    signal.current!.send({ t: "reject", to: s.id, reason: "El locutorio no puede atender este envío ahora." });
    wipe(s.id);
  }

  function wipe(id: string) {
    const s = sessionsRef.current.find((x) => x.id === id);
    s?.files.forEach((f) => URL.revokeObjectURL(f.url));
    links.current.get(id)?.close();
    links.current.delete(id);
    setSessions((l) => l.filter((x) => x.id !== id));
  }

  function print(s: Session, f: Received) {
    const frame = document.createElement("iframe");
    frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0";
    frame.src = f.url;
    frame.onload = () => {
      setTimeout(() => {
        try { frame.contentWindow?.focus(); frame.contentWindow?.print(); } catch { window.open(f.url, "_blank"); }
        setTimeout(() => frame.remove(), 60_000);
      }, 300);
    };
    document.body.appendChild(frame);
    patch(s.id, { status: "printed" });
  }

  const active = sessions.filter((s) => s.status !== "connected");
  const waiting = sessions.length - active.length;

  return (
    <main className="station">
      <header className="topbar">
        <strong>GO Print · Estación de recepción</strong>
        <span className="muted">{name}</span>
        <button className="link" onClick={() => setSettings((v) => !v)}>⚙ Ajustes</button>
      </header>

      {signalingMode === "local" && (
        <div className="notice">Modo local de pruebas: sin Supabase configurado solo conecta con pestañas de este mismo navegador.</div>
      )}

      {settings && (
        <div className="card settings">
          <label>Nombre del locutorio<input value={name} maxLength={40} onChange={(e) => setName(e.target.value)} /></label>
          <label>€/pág blanco y negro<input type="number" min="0" step="0.01" value={tariff.bn} onChange={(e) => setTariff({ ...tariff, bn: Math.max(0, Number(e.target.value)) })} /></label>
          <label>€/pág color<input type="number" min="0" step="0.01" value={tariff.color} onChange={(e) => setTariff({ ...tariff, color: Math.max(0, Number(e.target.value)) })} /></label>
        </div>
      )}

      <div className="layout">
        <aside className="card qr">
          <h2>Escanea para imprimir</h2>
          {qr && <img src={qr} alt="Código QR para enviar archivos" />}
          <p className="code">{room}</p>
          <a className="tiny" href={clientUrl} target="_blank" rel="noreferrer">{clientUrl}</a>
          <button className="btn secondary" onClick={() => setRoom(randomId())}>Generar código nuevo</button>
          <p className="tiny muted">{waiting > 0 ? `${waiting} cliente(s) conectado(s) eligiendo archivos` : "Esperando clientes…"}</p>
        </aside>

        <section className="jobs">
          {active.length === 0 && <div className="card center muted">Aún no hay envíos. Los archivos se guardan solo en la memoria de esta pestaña y se borran al imprimir, a los 15 minutos o al cerrarla.</div>}
          {active.map((s) => (
            <article key={s.id} className={`card job ${s.status}`}>
              <div className="job-head">
                <div>
                  <strong>{s.name}</strong> <span className="muted">· {s.id.slice(0, 4)}</span>
                  {s.request && (
                    <div className="muted">
                      {s.request.files.length} archivo(s) · {s.request.copies} copia(s) · {s.request.color === "bn" ? "B/N" : "Color"} · {s.request.pages} pág. en total
                    </div>
                  )}
                </div>
                {s.price !== undefined && <span className="price">{euros(s.price)}</span>}
              </div>

              {s.status === "pending" && (
                <div className="actions">
                  <button className="btn" onClick={() => accept(s)}>Aceptar</button>
                  <button className="btn ghost" onClick={() => reject(s)}>Rechazar</button>
                </div>
              )}

              {s.status === "receiving" && <div className="bar"><div style={{ width: `${Math.round(s.progress * 100)}%` }} /></div>}

              {s.files.length > 0 && (
                <ul className="files">
                  {s.files.map((f) => {
                    const declared = s.request?.files[f.index]?.pages;
                    const mismatch = f.pages !== null && declared !== undefined && f.pages !== declared;
                    return (
                      <li key={f.url} className={f.ok && !mismatch ? "" : "bad"}>
                        <span className="name">{f.name}</span>
                        <span className="muted">
                          {!f.ok ? "Dañado" : f.pages === null ? "…" : `${f.pages} pág.`}
                          {mismatch && ` (el móvil dijo ${declared})`}
                        </span>
                        <button className="btn small" disabled={!f.ok || s.status === "receiving"} onClick={() => print(s, f)}>Imprimir</button>
                        <a className="btn small ghost" href={f.url} target="_blank" rel="noreferrer">Ver</a>
                      </li>
                    );
                  })}
                </ul>
              )}

              {s.error && <p className="error">{s.error}</p>}

              <div className="job-foot">
                <span className="tiny muted">
                  {s.status === "ready" && (s.route === "relay" ? "Recibido por relé cifrado" : "Recibido por conexión directa")}
                  {s.status === "printed" && "Enviado a imprimir"}
                </span>
                {s.status !== "pending" && s.status !== "receiving" && <button className="btn small ghost" onClick={() => wipe(s.id)}>Terminar y borrar</button>}
              </div>
            </article>
          ))}
        </section>
      </div>
    </main>
  );
}

function notify(text: string) {
  document.title = `● ${text}`;
  setTimeout(() => (document.title = "GO Print"), 8000);
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    osc.frequency.value = 880;
    osc.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.15);
  } catch { /* sin audio */ }
}
