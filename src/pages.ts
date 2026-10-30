// Cuenta páginas en el propio dispositivo (el archivo no sale de aquí para esto).
let workerReady = false;

export async function countPages(file: Blob): Promise<number> {
  if (file.type !== "application/pdf") return 1; // una imagen = una página
  const pdfjs = await import("pdfjs-dist");
  if (!workerReady) {
    pdfjs.GlobalWorkerOptions.workerSrc = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")).default;
    workerReady = true;
  }
  const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
  const n = (await task.promise).numPages;
  await task.destroy();
  return n;
}
