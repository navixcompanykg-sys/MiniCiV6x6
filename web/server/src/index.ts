import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { attachGameProtocol } from "./wsServer";
import { listRooms, deleteRoom } from "./rooms";

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
  // Удаление сохранения (по прямому запросу — «в разделе сохранения добавь функцию удалить
  // сохранение») — DELETE /api/rooms/<id>, тот же публичный доступ без auth, что и у GET выше
  // (roomId и так непубличный секрет только по своей неугадываемости, см. rooms.ts: randomRoomId).
  if (req.method === "DELETE" && req.url?.startsWith("/api/rooms/")) {
    const id = decodeURIComponent(req.url.slice("/api/rooms/".length));
    await deleteRoom(id);
    res.statusCode = 204;
    res.end();
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
