-- Synthetic continuation event for local development only.
-- Claim URL: /claim/mvp-demo?code=demo-claim-2026

INSERT INTO live_events (
  event_id,
  slug,
  title,
  description,
  image_url,
  event_url,
  starts_at,
  claim_opens_at,
  claim_closes_at,
  max_supply,
  status
) VALUES (
  'event-mvp-demo',
  'mvp-demo',
  '協會數位紀念章 MVP 測試',
  '用來驗證唯一領取碼、地址登記，以及新舊收藏合併顯示的本機測試活動。',
  '/brand/logo_poap.svg',
  NULL,
  '2026-08-01T00:00:00.000Z',
  '2026-07-01T00:00:00.000Z',
  '2099-12-31T23:59:59.999Z',
  100,
  'published'
);

INSERT INTO live_claim_codes (code_hash, event_id, access_code_hash)
VALUES (
  '1dfbf035bfcbc47e3afc7f210fb700359c8b58de81d86367ec71e28a39853cb0',
  'event-mvp-demo',
  '1dfbf035bfcbc47e3afc7f210fb700359c8b58de81d86367ec71e28a39853cb0'
);

INSERT INTO live_events (
  event_id,
  slug,
  title,
  description,
  image_url,
  event_url,
  starts_at,
  claim_opens_at,
  claim_closes_at,
  max_supply,
  status,
  claim_mode
) VALUES (
  'event-shared-demo',
  'shared-demo',
  '共用 QR 測試活動',
  '同一張 QR 可供兩個不同地址領取，但每個地址只能領取一次。',
  '/brand/logo_poap.svg',
  NULL,
  '2026-08-01T00:00:00.000Z',
  '2026-07-01T00:00:00.000Z',
  '2099-12-31T23:59:59.999Z',
  2,
  'published',
  'shared'
);

INSERT INTO live_claim_codes (code_hash, event_id, access_code_hash)
VALUES
  (
    '308ac00bb42919b8a3617893761eb87ab7061d8ae222d1077aaf8334ce8832f2',
    'event-shared-demo',
    '2afff4b52bbb7fab553b52598e94cf841994c0e2fb1f3917722b516c4a63fa63'
  ),
  (
    '02576400fa063176336c94ff0746e2d1a2ea94bb8ba19c8f4355682a6eb9b2d0',
    'event-shared-demo',
    '2afff4b52bbb7fab553b52598e94cf841994c0e2fb1f3917722b516c4a63fa63'
  );

INSERT INTO live_events (
  event_id,
  slug,
  title,
  description,
  image_url,
  event_url,
  starts_at,
  claim_opens_at,
  claim_closes_at,
  chain_id,
  contract_address,
  token_id,
  max_supply,
  status,
  claim_mode
) VALUES (
  'event-mint-demo',
  'mint-demo',
  'Base Sepolia 鑄造測試',
  '用來驗證領取資格能安全換成 EIP-712 鑄造授權。',
  '/brand/logo_poap.svg',
  NULL,
  '2026-08-01T00:00:00.000Z',
  '2026-07-01T00:00:00.000Z',
  '2099-12-31T23:59:59.999Z',
  84532,
  '0x1111111111111111111111111111111111111111',
  '1',
  1,
  'published',
  'unique'
);

INSERT INTO live_claim_codes (code_hash, event_id, access_code_hash)
VALUES (
  '1851cac87456be2727a62c017e4ae0d7ea21ee05e6a1b26a9d40db3084f9e2ad',
  'event-mint-demo',
  '1851cac87456be2727a62c017e4ae0d7ea21ee05e6a1b26a9d40db3084f9e2ad'
);

INSERT INTO live_events (
  event_id,
  slug,
  title,
  description,
  image_url,
  event_url,
  starts_at,
  claim_opens_at,
  claim_closes_at,
  chain_id,
  contract_address,
  token_id,
  max_supply,
  status,
  claim_mode
) VALUES (
  'event-email-demo',
  'email-demo',
  'Email 預約測試',
  '先用 Email 保留資格，再於日後綁定既有錢包。',
  '/brand/logo_poap.svg',
  NULL,
  '2026-08-01T00:00:00.000Z',
  '2026-07-01T00:00:00.000Z',
  '2099-12-31T23:59:59.999Z',
  84532,
  '0x1111111111111111111111111111111111111111',
  '2',
  2,
  'published',
  'shared'
);

INSERT INTO live_claim_codes (code_hash, event_id, access_code_hash)
VALUES
  (
    '477282b99231857ce63ddea34579def3d49a44afdd6182d2f17893831d66cec0',
    'event-email-demo',
    'c7f542ca5d169645cd2d6191f0cec2d16d81fde56188719232c865683575b120'
  ),
  (
    'bc6b5be2de7ea2d0e90d277738db9576ea1525f1754f1b73e5ed54ce50dc76a3',
    'event-email-demo',
    'c7f542ca5d169645cd2d6191f0cec2d16d81fde56188719232c865683575b120'
  );
