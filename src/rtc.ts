// Túnel directo WebRTC entre el móvil y el PC del locutorio.
// Los datos van cifrados (DTLS) de extremo a extremo; si hace falta un relé TURN,
// este solo reenvía bytes cifrados que no puede leer ni guarda.
import { CHUNK, MAX_FILE_BYTES, sha256, type DataControl } from "./protocol";

function iceServers(): RTCIceServer[] {
  const servers: RTCIceServer[] = [{ urls: ["stun:stun.l.google.com:19302", "stun:stun.cloudflare.com:3478"] }];
  const turn = import.meta.env.VITE_TURN_URL as string | undefined;
  if (turn) {
    servers.push({
      urls: turn.split(",").map((u) => u.trim()),
      username: import.meta.env.VITE_TURN_USERNAME as string,
      credential: import.meta.env.VITE_TURN_CREDENTIAL as string,
    });
  }
  return servers;
}

// Envoltorio que guarda los candidatos ICE que llegan antes de la descripción remota.
export class PeerLink {
  readonly pc = new RTCPeerConnection({ iceServers: iceServers() });
  private pending: RTCIceCandidateInit[] = [];

  constructor(onIce: (c: RTCIceCandidateInit) => void) {
    this.pc.onicecandidate = (e) => e.candidate && onIce(e.candidate.toJSON());
  }

  async setRemote(sdp: RTCSessionDescriptionInit) {
    await this.pc.setRemoteDescription(sdp);
    for (const c of this.pending.splice(0)) await this.pc.addIceCandidate(c).catch(() => {});
  }

  async addIce(c: RTCIceCandidateInit) {
    if (this.pc.remoteDescription) await this.pc.addIceCandidate(c).catch(() => {});
    else this.pending.push(c);
  }

  // "direct" = misma red o P2P por Internet; "relay" = pasando por TURN.
  async route(): Promise<"direct" | "relay" | "unknown"> {
    const stats = await this.pc.getStats();
    let pairId: string | undefined;
    stats.forEach((s) => {
      if (s.type === "transport" && s.selectedCandidatePairId) pairId = s.selectedCandidatePairId;
    });
    const pair = pairId ? stats.get(pairId) : undefined;
    const local = pair ? stats.get(pair.localCandidateId) : undefined;
    if (!local) return "unknown";
    return local.candidateType === "relay" ? "relay" : "direct";
  }

  close() {
    this.pc.close();
  }
}

function waitBufferLow(dc: RTCDataChannel) {
  return new Promise<void>((resolve, reject) => {
    const done = () => { dc.removeEventListener("bufferedamountlow", done); dc.removeEventListener("close", fail); resolve(); };
    const fail = () => { dc.removeEventListener("bufferedamountlow", done); reject(Error("Conexión cerrada")); };
    dc.addEventListener("bufferedamountlow", done);
    dc.addEventListener("close", fail);
  });
}

// Cliente: envía los archivos por trozos respetando el búfer del canal.
export async function sendFiles(
  link: PeerLink,
  dc: RTCDataChannel,
  files: File[],
  onProgress: (sent: number, total: number) => void,
) {
  const chunk = Math.min(CHUNK, link.pc.sctp?.maxMessageSize || 16 * 1024);
  const total = files.reduce((n, f) => n + f.size, 0);
  let sent = 0;
  dc.bufferedAmountLowThreshold = 1 << 20;
  for (const [index, file] of files.entries()) {
    const buf = await file.arrayBuffer();
    const head: DataControl = { t: "file", index, name: file.name, size: file.size, mime: file.type, sha256: await sha256(buf) };
    dc.send(JSON.stringify(head));
    for (let off = 0; off < buf.byteLength; off += chunk) {
      if (dc.bufferedAmount > 8 << 20) await waitBufferLow(dc);
      const part = buf.slice(off, off + chunk);
      dc.send(part);
      sent += part.byteLength;
      onProgress(sent, total);
    }
  }
  dc.send(JSON.stringify({ t: "done" } satisfies DataControl));
}

export interface ReceivedFile {
  index: number;
  name: string;
  mime: string;
  blob: Blob;
  ok: boolean; // la huella SHA-256 coincide
}

// Estación: reconstruye cada archivo en memoria y comprueba su integridad.
export function receiveFiles(
  dc: RTCDataChannel,
  handlers: {
    onProgress(bytes: number): void;
    onFile(file: ReceivedFile): void;
    onDone(): void;
    onError(msg: string): void;
  },
) {
  dc.binaryType = "arraybuffer";
  let meta: Extract<DataControl, { t: "file" }> | null = null;
  let parts: ArrayBuffer[] = [];
  let got = 0;
  let total = 0;
  let pending = Promise.resolve();

  const finish = () => {
    const m = meta!, p = parts;
    meta = null; parts = []; got = 0;
    pending = pending.then(async () => {
      const blob = new Blob(p, { type: m.mime || "application/octet-stream" });
      const ok = (await sha256(await blob.arrayBuffer())) === m.sha256;
      dc.send(JSON.stringify({ t: "ack", index: m.index, ok } satisfies DataControl));
      handlers.onFile({ index: m.index, name: m.name, mime: m.mime, blob, ok });
    });
  };

  dc.onmessage = (e) => {
    if (typeof e.data === "string") {
      const msg = JSON.parse(e.data) as DataControl;
      if (msg.t === "file") {
        if (msg.size > MAX_FILE_BYTES) { handlers.onError("Archivo demasiado grande"); dc.close(); return; }
        meta = msg;
        if (msg.size === 0) finish();
      } else if (msg.t === "done") {
        pending = pending.then(handlers.onDone);
      }
      return;
    }
    if (!meta) return;
    const buf = e.data as ArrayBuffer;
    got += buf.byteLength;
    total += buf.byteLength;
    if (got > meta.size) { handlers.onError("Datos inesperados"); dc.close(); return; }
    parts.push(buf);
    handlers.onProgress(total);
    if (got === meta.size) finish();
  };
}
