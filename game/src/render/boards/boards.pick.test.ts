import '../../test/fakeCanvas';
import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import type { BoardIssues, IssueCard } from '../../net/protocol';
import { floorLayout } from '../../world/layout';
import { issuePlacements, wallColumns } from '../../world/boards';
import type { WorkerView } from '../../world/store';
import { BoardsView } from './boards';
import { ISSUE_CELL } from './paint';

// A click on a holder's tag on the wall note goes to that worker; a click on the rest of the note, or beside it, does not.

const card: IssueCard = { id: 'a/b#54', key: '#54', title: 'Hiring a worker sometimes teleports the player', state: 'open', column: 'doing', labels: [], assignees: [], updated_at: 1, closed_at: null };
const msg: BoardIssues = {
  t: 'board.issues',
  session: 's',
  provider: 'github',
  provider_name: 'GitHub',
  initial: false,
  fetched_at: 5,
  columns: [
    { id: 'todo', name: 'Todo' },
    { id: 'doing', name: 'Doing' },
  ],
  cards: [card],
};
const worker = { worker: { id: 'w1', work_item: { id: card.id } }, name: 'Kiwi' } as unknown as WorkerView;

describe('BoardsView.pickHolder', () => {
  const L = floorLayout(60);
  const view = new BoardsView(L.props, L.height, () => {});
  const board = L.props.find((p) => p.id === 'board.issues');
  if (!board) throw new Error('no issue board');
  view.setIssues({ msg, off: null }, [worker], 0);
  view.group.updateMatrixWorld(true);
  const origin = new THREE.Vector3(board.box.min[0], board.box.min[1], board.box.max[2]);
  const size = { w: board.box.max[0] - board.box.min[0], h: board.box.max[1] - board.box.min[1] };
  const place = issuePlacements(wallColumns(msg).columns, size)[0];
  if (!place) throw new Error('no placement');

  /** A ray straight at a point of the note's cell (px, y down), from a metre in front of the wall. */
  const at = (u: number, v: number): THREE.Ray => {
    const lx = (u / ISSUE_CELL.w - 0.5) * place.w;
    const ly = (0.5 - v / ISSUE_CELL.h) * place.h;
    const c = Math.cos(place.rot);
    const s = Math.sin(place.rot);
    const x = origin.x + place.x + lx * c - ly * s;
    const y = origin.y + place.y + lx * s + ly * c;
    return new THREE.Ray(new THREE.Vector3(x, y, origin.z + 1), new THREE.Vector3(0, 0, -1));
  };

  it('finds the worker on its tag, top right of the note', () => {
    expect(view.pickHolder(at(ISSUE_CELL.w - 40, 32))).toBe('w1');
  });

  it('finds nobody on the rest of the note, or off it', () => {
    expect(view.pickHolder(at(60, 130))).toBeNull();
    expect(view.pickHolder(at(40, 32))).toBeNull();
    expect(view.pickHolder(new THREE.Ray(new THREE.Vector3(origin.x + 0.01, origin.y + 0.01, origin.z + 1), new THREE.Vector3(0, 0, -1)))).toBeNull();
  });

  it('finds nobody when the ray points away from the wall', () => {
    expect(view.pickHolder(new THREE.Ray(new THREE.Vector3(0, 0, origin.z + 1), new THREE.Vector3(0, 0, 1)))).toBeNull();
  });
});
