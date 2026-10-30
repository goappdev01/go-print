// Mensajes que intercambian cliente (móvil) y estación (PC del locutorio).

export type ColorMode = "bn" | "color";

export interface Tariff {
  bn: number; // € por página en blanco y negro
  color: number; // € por página en color
}

export interface FileMeta {
  name: string;
  size: number;
  mime: string;
  pages: number;
}

export interface PrintRequest {
  files: FileMeta[];
  copies: number;
  color: ColorMode;
  pages: number; // total de páginas a imprimir (páginas × copias)
  price: number;
}

// Por señalización (Supabase Realtime): siempre llevan el id del cliente.
export type SignalMessage =
  | { t: "hello"; from: string; name: string }
  | { t: "welcome"; to: string; station: string; tariff: Tariff }
  | { t: "request"; from: string; request: PrintRequest }
  | { t: "accept"; to: string }
  | { t: "reject"; to: string; reason: string }
  | { t: "offer" | "answer"; from?: string; to?: string; sdp: RTCSessionDescriptionInit }
  | { t: "ice"; from?: string; to?: string; candidate: RTCIceCandidateInit }
  | { t: "closed"; station: string };

// Por el canal de datos WebRTC (directo, cifrado).
export type DataControl =
  | { t: "file"; index: number; name: string; size: number; mime: string; sha256: string }
  | { t: "done" }
  | { t: "ack"; index: number; ok: boolean };

export const CHUNK = 64 * 1024;
export const MAX_FILE_BYTES = 100 * 1024 * 1024;
export const ACCEPTED = ["application/pdf", "image/jpeg", "image/png", "image/webp"];

export function priceOf(pages: number, copies: number, color: ColorMode, tariff: Tariff) {
  const total = pages * copies;
  return { pages: total, price: Math.round(total * tariff[color] * 100) / 100 };
}

export const euros = (n: number) =>
  n.toLocaleString("es-ES", { style: "currency", currency: "EUR" });

export function randomId(len = 8) {
  const abc = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes, (b) => abc[b % abc.length]).join("");
}

export async function sha256(buf: ArrayBuffer) {
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("");
}
