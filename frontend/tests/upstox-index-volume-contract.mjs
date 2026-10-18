// No synthetic volumes from Upstox cash-index OHLC or tick counts.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const front=name=>readFileSync(new URL('../src/'+name,import.meta.url),'utf8');
const rust=name=>readFileSync(new URL('../../services/stream-rust/src/'+name,import.meta.url),'utf8');
const history=rust('personal_index.rs'),websocket=rust('main.rs');
const feed=front('personal-index-feed.js');
const chart=front('private-index-history-chart.jsx');
const markets=front('market-explorer.jsx');
assert.ok(history.includes('"volume_available":false,"volume_status":"not_applicable_index"'));
assert.ok(websocket.includes('"volume_available":false'));
assert.ok(websocket.includes('"volume_status":"not_applicable_index"'));
assert.ok(history.includes('"close":c.close,"volume":0}'));
assert.ok(feed.includes('bar.volume!==0'));
assert.ok(feed.includes('json.volume_available===true'));
assert.ok(feed.includes('data?.volume_available===true'));
assert.match(chart,/Volume: N\/A for cash indices/);
assert.match(markets,/Index volume: N\/A/);
console.log('PASS: index volume is explicitly N/A and never inferred from price ticks');
