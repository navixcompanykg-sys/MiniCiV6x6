import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { attachGameProtocol } from "./wsServer";
import { listRooms } from "./rooms";

const PORT = Number(process.env.PORT ?? 8787);

const httpServer = createServer(async (req, res) => {
  // Клиент (Vite dev, :5173) и сервер (:8787) — разные origin, поэтому без CORS-заголовка браузер
  // блокировал fetch('/api/rooms') ещё до того, как запрос вообще уходил на сервер — это и прятало
  // кнопку «Загрузить игру» в start.html. Ответ публичный (список комнат, без секретов), так что
  // открыть его любому origin безопасно.
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.url === "/api/rooms" && req.method === "GET") {
    const rooms = await listRooms();
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(rooms));
    return;
  }
  res.statusCode = 404;
  res.end("not found");
});

const wss = new WebSocketServer({ server: httpServer, path: "/ws" });
attachGameProtocol(wss);

httpServer.listen(PORT, () => {
  console.log(`civa-server: слушаю ws://localhost:${PORT}/ws (и GET http://localhost:${PORT}/api/rooms)`);
});
