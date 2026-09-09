import type { SaveGameV1 } from "./GameSession";
import type { CardDef } from "../../src/game/cards";

/** Своя рука — полный список карт; чужая — только число (клиент рисует «рубашки»), см. toPrivateView. */
export type PrivateHandView = CardDef[] | { count: number };

export interface PrivateStateView extends Omit<SaveGameV1, "hands" | "deck" | "rngSeed" | "rngCallCount"> {
  hands: Record<number, PrivateHandView>;
  /** Замена deck: CardDef[] — порядок будущих карт колоды не должен быть виден никому, кроме
   * сервера (иначе игрок мог бы планировать ход, зная, что вытянет дальше). Число карт достаточно
   * для UI (счётчик колоды), содержимого нет вовсе. */
  deckCount: number;
}

/**
 * Фильтрует полный снимок партии (SaveGameV1, то, что сегодня рассылается ВСЕМ клиентам хотсита без
 * разбора — см. wsServer.ts: broadcastState) под конкретного получателя, для WeGo-комнат:
 * - Чужие руки видны только числом карт, своя — целиком.
 * - Колода (deck) скрыта полностью — только счётчик (deckCount), иначе будущие карты предсказуемы.
 * - RNG-поля (rngSeed/rngCallCount) не отдаются клиенту вовсе — знание их вместе позволило бы
 *   заранее просчитать все будущие "случайные" исходы партии (детерминированный Mulberry32, см.
 *   GameSession.rng).
 * Всё остальное (карта, города, юниты, рынок, дипломатия, деньги/технологии/парадигма/религия
 * других игроков) остаётся видимым как есть — ровно то же, что сегодня видно всем в хотсите; нет
 * оснований в ТЗ/СПРАВОЧНИКЕ считать эти поля приватными, и делать их приватными без явного запроса
 * не нужно (список скрываемых полей сознательно локализован в этой одной функции, легко расширить).
 * viewerPlayerId===null — режим наблюдателя без своего слота: своей руки нет вовсе, все руки видны
 * только числом.
 */
export function toPrivateView(save: SaveGameV1, viewerPlayerId: number | null): PrivateStateView {
  const { hands, deck, rngSeed: _rngSeed, rngCallCount: _rngCallCount, ...publicFields } = save;
  const filteredHands: Record<number, PrivateHandView> = {};
  for (const [idStr, hand] of Object.entries(hands)) {
    const id = Number(idStr);
    filteredHands[id] = id === viewerPlayerId ? hand : { count: hand.length };
  }
  return { ...publicFields, hands: filteredHands, deckCount: deck.length };
}
