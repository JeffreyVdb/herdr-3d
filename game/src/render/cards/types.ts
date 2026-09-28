import type { Display } from '../../world/derive';

export interface CardData {
  name: string;
  display: Display;
  task: string;
}

export interface Viewport {
  width: number;
  height: number;
}

export const sameCard = (a: CardData | null, b: CardData | null) =>
  a === b || (!!a && !!b && a.name === b.name && a.display === b.display && a.task === b.task);
