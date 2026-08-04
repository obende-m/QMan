import type { DisplayBoardConfig } from "@qman/domain";
import { configStore } from "./config-store.js";

/**
 * Display board lookup.
 *
 * Boards used to be a hardcoded array here. They now live in the hospital
 * configuration, so adding a board for a new waiting area is something an
 * administrator does in the portal rather than something a developer does in a
 * release.
 */
export type { DisplayBoardConfig };

export function displayBoards(): readonly DisplayBoardConfig[] {
  return configStore.config.displayBoards;
}

export function boardById(id: string): DisplayBoardConfig {
  return configStore.board(id) ?? configStore.config.displayBoards[0]!;
}
