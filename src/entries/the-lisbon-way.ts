import { startAppSafely } from '../shell/app.js';
import { refreshWall } from '../shell/wall-data.js';
import { lisbonWayAdapter } from '../games/the-lisbon-way/client.js';

(window as unknown as { __arcadeBoot?: string }).__arcadeBoot = 'ran';   // the module evaluated (see the boot guard in index.html)
void refreshWall();
startAppSafely(lisbonWayAdapter);
