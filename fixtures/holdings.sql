-- Synthetic holder addresses keep the local fixture detached from real wallets.
-- Never apply this file as a production migration.

INSERT INTO archive_meta (key, value) VALUES
  ('snapshot_id', 'compass-holdings-2026-07-28-v1'),
  ('snapshot_at', '2026-07-28T05:04:31.465Z'),
  ('schema_version', '1'),
  ('importer_version', 'development-fixture'),
  ('artwork_release_id', '2026-07-02-v1-artwork-full'),
  ('artwork_release_collections_snapshot_id', 'collections-2026-07-22-v1'),
  ('artwork_release_sha256', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
  ('artwork_release_complete', '1'),
  ('artwork_release_referenced_drops', '3'),
  ('artwork_release_archive_direct', '1'),
  ('artwork_release_activated_rows', '2'),
  ('artwork_release_terminal_unavailable', '0'),
  ('tokens_count', '3'),
  ('owners_count', '2');

INSERT INTO tokens (
  source_uid,
  poap_id,
  drop_id,
  minted_on,
  owner_address_norm,
  network,
  transfer_count
) VALUES
  (
    '00000000000000000000000000000001',
    1,
    1,
    1532044800,
    '0x1111111111111111111111111111111111111111',
    'mainnet',
    0
  ),
  (
    '00000000000000000000000000000002',
    2,
    2,
    1540771200,
    '0x1111111111111111111111111111111111111111',
    'xdai',
    1
  ),
  (
    '00000000000000000000000000000003',
    3,
    3,
    1447027200,
    '0x3333333333333333333333333333333333333333',
    'xdai',
    0
  );

INSERT INTO owner_stats (
  owner_address_norm,
  token_count,
  unique_drop_count,
  first_minted_on,
  last_minted_on
) VALUES
  ('0x1111111111111111111111111111111111111111', 2, 2, 1532044800, 1540771200),
  ('0x3333333333333333333333333333333333333333', 1, 1, 1447027200, 1447027200);
