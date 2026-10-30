// Señalización: el único dato que pasa por un servidor son mensajes cortos para que
// el móvil y el PC del locutorio se encuentren. El archivo NUNCA pasa por aquí.
import { createClient, type RealtimeChannel } from "@supabase/supabase-js";
import type { SignalMessage } from "./protocol";

export interface Signal {
  send(msg: SignalMessage): void;
  close(): void;
}

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
const supabase = url && key ? createClient(url, key) : null;

export const signalingMode: "supabase" | "local" = supabase ? "supabase" : "local";

export function joinRoom(room: string, onMessage: (msg: SignalMessage) => void): Signal {
  const name = `gp-${room}`;
  if (!supabase) {
    // Modo local de pruebas: solo funciona entre pestañas del mismo navegador.
    const bc = new BroadcastChannel(name);
    bc.onmessage = (e) => onMessage(e.data as SignalMessage);
    return { send: (m) => bc.postMessage(m), close: () => bc.close() };
  }
  const channel: RealtimeChannel = supabase.channel(name, { config: { broadcast: { self: false } } });
  const queue: SignalMessage[] = [];
  let ready = false;
  channel.on("broadcast", { event: "m" }, ({ payload }) => onMessage(payload as SignalMessage));
  channel.subscribe((status) => {
    if (status !== "SUBSCRIBED") return;
    ready = true;
    for (const m of queue.splice(0)) void channel.send({ type: "broadcast", event: "m", payload: m });
  });
  return {
    send(m) {
      if (ready) void channel.send({ type: "broadcast", event: "m", payload: m });
      else queue.push(m);
    },
    close: () => void supabase.removeChannel(channel),
  };
}
