import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Station } from "./Station";
import { Client } from "./Client";
import "./styles.css";

function Home() {
  return (
    <main className="home">
      <h1>GO Print</h1>
      <p className="lead">Imprime desde tu móvil en el locutorio. Tu archivo viaja directo y cifrado a la impresora y nunca se guarda en ningún servidor.</p>
      <div className="card">
        <h2>¿Eres cliente?</h2>
        <p>Escanea el código QR que verás en el mostrador del locutorio.</p>
      </div>
      <a className="btn secondary" href="/estacion">Soy el locutorio: abrir estación de recepción</a>
    </main>
  );
}

const params = new URLSearchParams(location.search);
const room = params.get("s");
const view = room ? <Client room={room.toUpperCase()} /> : location.pathname.startsWith("/estacion") ? <Station /> : <Home />;

createRoot(document.getElementById("root")!).render(<StrictMode>{view}</StrictMode>);
