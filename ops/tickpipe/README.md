# Owner-only TickPipe offline import

Run on the recording workstation, not the QSYN web host. Use TickPipe v0.2.0 in
its own Python environment; the importer uses its Polars dependency. Stop
recording before importing so the part list is stable. Keep the recording and
output directories private and outside any document root.

```sh
python ops/tickpipe/import_session.py --recording /private/ticks \
  --date YYYY-MM-DD --symbol NFO:CONTRACT --output /private/qsyn-replay
python -m unittest discover -s ops/tickpipe
```

Select one UTC partition and one broker contract. The bundle preserves receive
and feed timestamps, sequence and reported quantities. It contains deterministic
one-second and one-minute OHLC in receive-time buckets. Empty buckets are not
filled. Sequence gaps indicate missing rows within the selected partition, not
broker disconnects or exchange coverage. Snapshot quantities are not exchange
trade quantities; OHLC intentionally does not include volume. Quotes/depth
are not imported. Keep bundles separate from live chart data. In Terminal → Workspaces → TickPipe replay, choose the generated JSON bundle
(up to 32 MiB). Replay shows one recorded candle at a time, not individual
exchange events. Empty time buckets remain blank. Playback speed is candles
per second, not exchange-clock speed. The file never uploads and is not
persisted by the terminal. No live chart or trading integration.
