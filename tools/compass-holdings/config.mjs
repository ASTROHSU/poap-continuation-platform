export const DEFAULT_ENDPOINT = "https://public.compass.poap.tech/v1/graphql";
export const DEFAULT_CONCURRENCY = 4;
export const DEFAULT_DELAY_MS = 125;
export const DEFAULT_SHARDS = 16;
export const PAGE_SIZE = 100;
export const SNAPSHOT_FORMAT_VERSION = 1;

export const REQUIRED_POAP_FIELDS = [
  "chain",
  "collected_at",
  "collector_address",
  "drop_id",
  "id",
  "minted_on",
  "transfer_count",
];

export const UPPER_BOUND_QUERY = `
query POAPinCompassHoldingsUpperBound {
  poaps(limit: 1, order_by: { id: desc }) {
    id
  }
}
`;

export const SHARD_COUNT_QUERY = `
query POAPinCompassHoldingsShardCount($lower: bigint!, $upper: bigint!) {
  poaps_aggregate(where: { id: { _gt: $lower, _lte: $upper } }) {
    aggregate {
      count
    }
  }
}
`;

export const NULL_CHAIN_COUNT_QUERY = `
query POAPinCompassHoldingsNullChainCount($upper: bigint!) {
  poaps_aggregate(
    where: {
      id: { _lte: $upper }
      chain: { _is_null: true }
    }
  ) {
    aggregate {
      count
    }
  }
}
`;

export const DISTINCT_IDENTITY_COUNT_QUERY = `
query POAPinCompassHoldingsDistinctIdentityCount($upper: bigint!) {
  poaps_aggregate(
    distinct_on: [id, chain]
    where: { id: { _lte: $upper } }
  ) {
    aggregate {
      count
    }
  }
}
`;

export const PAGE_QUERY = `
query POAPinCompassHoldingsPage(
  $lower: bigint!
  $upper: bigint!
  $afterId: bigint!
  $afterChain: String!
  $limit: Int!
) {
  poaps(
    limit: $limit
    order_by: [{ id: asc }, { chain: asc }]
    where: {
      _and: [
        { id: { _gt: $lower, _lte: $upper } }
        {
          _or: [
            { id: { _gt: $afterId } }
            {
              _and: [
                { id: { _eq: $afterId } }
                { chain: { _gt: $afterChain } }
              ]
            }
          ]
        }
      ]
    }
  ) {
    id
    drop_id
    minted_on
    collector_address
    chain
    transfer_count
    collected_at
  }
}
`;

export const SOURCE_UID_DERIVATION = "compass-poap:<poap_id>:<chain>";
