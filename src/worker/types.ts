export interface Bindings {
  CATALOG_DB: D1Database;
  HOLDINGS_DB: D1Database;
  COLLECTIONS_DB: D1Database;
  MOMENTS_DB: D1Database;
  LIVE_DB: D1Database;
  ARCHIVE_BUCKET: R2Bucket;
  ARCHIVE_MEDIA_BUCKET: R2Bucket;
  BROWSE_RATE_LIMITER: RateLimit;
  OWNER_RATE_LIMITER: RateLimit;
  EXPORT_RATE_LIMITER: RateLimit;
  SNAPSHOT_ID: string;
  HOLDINGS_SNAPSHOT_ID: string;
  COLLECTIONS_SNAPSHOT_ID: string;
  COLLECTIONS_RELEASE_ID: string;
  MOMENTS_SNAPSHOT_ID: string;
  MOMENTS_RELEASE_ID: string;
  MOMENTS_SOURCE_DATABASE_SHA256: string;
  MOMENTS_BUILD_MANIFEST_SHA256: string;
  API_CACHE_VERSION: string;
  MEDIA_BASE_URL: string;
  ETHEREUM_RPC_URL: string;
  BASE_RPC_URL: string;
  BASE_MAINNET_RPC_URL: string;
  ARBITRUM_MAINNET_RPC_URL: string;
  GNOSIS_MAINNET_RPC_URL: string;
  MINT_SIGNER_PRIVATE_KEY: string;
  MINT_RELAYER_PRIVATE_KEY: string;
  PUBLIC_APP_URL: string;
  EMAIL_PROVIDER: "console" | "resend";
  EMAIL_FROM: string;
  RESEND_API_KEY: string;
  EMAIL_LOOKUP_SECRET: string;
  EMAIL_DATA_KEY: string;
  WALLET_PROVISIONING_MODE: "disabled" | "magic-pregen";
  MAGIC_PUBLISHABLE_API_KEY: string;
  MAGIC_SECRET_KEY?: string;
  MAGIC_EMAIL_TEMPLATE_NAME?: string;
  APP_MODE: "combined" | "live-only";
}

export interface AppEnv {
  Bindings: Bindings;
}

export type D1ReadClient = Pick<D1DatabaseSession, "prepare" | "batch">;

export type DropSort = "recent" | "oldest" | "popular";
export type EventType = "all" | "virtual" | "in-person";
export type CollectionType = "all" | "artist" | "organization" | "user";

export interface DropsQuery {
  q: string | null;
  ftsQuery: string | null;
  year: number | null;
  type: EventType;
  sort: DropSort;
  limit: number;
  cursor: DropCursor | null;
  filterKey: string;
  canonicalSearch: string;
}

export interface OwnerQuery {
  address: string;
  limit: number;
  cursor: OwnerCursor | null;
  filterKey: string;
  canonicalSearch: string;
}

export interface DropCollectorsQuery {
  dropId: number;
  limit: number;
  cursor: DropCollectorsCursor | null;
  filterKey: string;
  canonicalSearch: string;
}

export interface PersonalHoldingsQuery {
  address: string;
  limit: number;
  cursor: PersonalHoldingsCursor | null;
  filterKey: string;
  canonicalSearch: string;
}

export interface OwnedCollectionsQuery {
  address: string;
  limit: number;
  cursor: OwnedCollectionsCursor | null;
  filterKey: string;
  canonicalSearch: string;
}

export interface CollectionsQuery {
  q: string | null;
  ftsQuery: string | null;
  year: number | null;
  type: CollectionType;
  limit: number;
  cursor: CollectionCursor | null;
  filterKey: string;
  canonicalSearch: string;
}

export interface CollectionItemsQuery {
  collectionId: number;
  limit: number;
  cursor: CollectionItemCursor | null;
  filterKey: string;
  canonicalSearch: string;
}

export type CollectionExportSegmentKind = "artist-drops" | "suggestions" | "drop-stats";

export interface CollectionExportSegmentQuery {
  collectionId: number;
  segment: CollectionExportSegmentKind;
  limit: number;
  cursor: CollectionExportSegmentCursor | null;
  filterKey: string;
  canonicalSearch: string;
}

export interface DropCursor {
  v: 1;
  s: string;
  f: string;
  p: number;
  k: string | number;
  i: number;
}

export interface OwnerCursor {
  v: 1;
  s: string;
  f: string;
  p: number;
  u: string;
}

export interface DropCollectorsCursor {
  v: 1;
  c: "drop-collectors";
  s: string;
  f: string;
  p: number;
  i: number;
  u: string;
  a: string;
}

export interface PersonalHoldingsCursor {
  v: 1;
  c: "personal-holdings";
  s: string;
  f: string;
  p: number;
  u: string;
}

export interface OwnedCollectionsCursor {
  v: 1;
  c: "owned-collections";
  s: string;
  f: string;
  p: number;
  k: string;
  i: number;
}

export interface CollectionCursor {
  v: 1;
  c: "collections";
  s: string;
  f: string;
  p: number;
  k: string;
  i: number;
}

export interface CollectionItemCursor {
  v: 1;
  c: "collection-items";
  s: string;
  f: string;
  p: number;
  i: number;
}

export interface CollectionExportSegmentCursor {
  v: 1;
  c: "collection-export-segment";
  s: string;
  f: string;
  p: number;
  g: CollectionExportSegmentKind;
  a?: string;
  d?: number;
  i?: number;
}

export interface CatalogSummaryRow {
  drop_id: number;
  fancy_id: string;
  title: string;
  start_date: string;
  city: string | null;
  country: string | null;
  year: number;
  is_virtual: number | null;
  token_count: number | null;
  has_artwork: number | null;
}

export interface CatalogDetailRow extends CatalogSummaryRow {
  is_private?: number | null;
  description: string | null;
  end_date: string;
  event_url: string | null;
  channel: string | null;
  platform: string | null;
  location_type: string | null;
  timezone: string | null;
  created_at: string;
  email_reservations_total: number | null;
  email_reservations_minted: number | null;
  email_reservations_unminted: number | null;
}

export interface HoldingRow {
  source_uid: string;
  poap_id: number;
  drop_id: number;
  minted_on: number;
  network: string;
  transfer_count: number;
}

export interface HoldingDropRow {
  drop_id: number;
  fancy_id: string;
  title: string;
  description: string | null;
  start_date: string;
  end_date: string;
  expiry_date: string | null;
  city: string | null;
  country: string | null;
  event_url: string | null;
  year: number;
  is_virtual: number | null;
  is_private: number;
  is_hidden: number;
  channel: string | null;
  platform: string | null;
  location_type: string | null;
  timezone: string | null;
  integrator_id: string | null;
  created_at: string;
  token_count: number;
  transfer_count: number;
  image_object_key: string | null;
}

export interface DropCollectorRow {
  source_uid: string;
  poap_id: number;
  minted_on: number | null;
  owner_address_norm: string;
  network: string;
  transfer_count: number;
}

export interface DropCollector {
  poapId: number;
  ownerAddress: string;
  mintedOn: number | null;
  network: string;
  transferCount: number;
}

export interface DropCollectorsPage {
  snapshotId: string;
  dropId: number;
  items: DropCollector[];
  nextCursor: string | null;
}

export interface ExportCatalogRow {
  drop_id: number;
  title: string;
  start_date: string;
  end_date: string;
  city: string | null;
  country: string | null;
  event_url: string | null;
  has_artwork: number;
}

export interface ArchiveMeta {
  snapshotId: string;
  snapshotAt: string;
  counts: {
    drops: number;
    tokens: number;
    owners: number;
    artworks: number;
  };
  years: number[];
}

export interface DropSummary {
  dropId: number;
  fancyId: string;
  title: string;
  startDate: string;
  city: string | null;
  country: string | null;
  year: number;
  isVirtual: boolean | null;
  imageUrl: string;
  hasArtwork: boolean;
  tokenCount: number;
  /**
   * Present when a private Drop is returned by an exact ID or exact-address
   * holdings lookup. Private Drops are never added to browse results.
   */
  isPrivate?: true;
  /**
   * Present when a hidden Drop is returned by an exact ID or exact-address
   * holdings lookup. Hidden Drops are never added to browse results.
   */
  isHidden?: true;
}

export interface DropDetail extends DropSummary {
  description: string | null;
  endDate: string;
  expiryDate?: string | null;
  eventUrl: string | null;
  channel: string | null;
  platform: string | null;
  locationType: string | null;
  timezone: string | null;
  integratorId?: string | null;
  createdAt: string;
  dropTransferCount?: number;
  reservationsTotal: number;
  reservationsMinted: number;
  reservationsUnminted: number;
  featuredOn?: string | null;
  momentsUploaded?: number | null;
}

export interface DropDetailBatch {
  schemaVersion: "poapin-drop-detail-batch-v1";
  snapshotId: string;
  requestedDropIds: number[];
  drops: DropDetail[];
  unavailableDropIds: number[];
}

export interface OwnerToken extends DropSummary {
  sourceUid: string;
  poapId: number;
  mintedOn: number | null;
  ownerAddress: string;
  network: string;
  transferCount: number;
}

export interface PersonalHoldingReference {
  sourceUid: string;
  poapId: number;
  dropId: number;
  mintedOn: number | null;
  ownerAddress: string;
  network: string;
  transferCount: number;
}

export interface PersonalHoldingsPage {
  schemaVersion: "poapin-personal-holdings-page-v2";
  snapshotId: string;
  catalogSnapshotId: string;
  collectionsSnapshotId: string;
  collectionsReleaseId: string;
  address: string;
  total: number;
  items: PersonalHoldingReference[];
  drops: DropDetail[];
  unavailableDropIds: number[];
  nextCursor: string | null;
}

export interface ExportRecord {
  snapshot_id: string;
  snapshot_at: string;
  queried_address: string;
  source_uid: string;
  poap_id: number;
  drop_id: number;
  title: string;
  start_date: string;
  end_date: string;
  city: string | null;
  country: string | null;
  event_url: string | null;
  network: string;
  minted_on: number | null;
  transfer_count: number;
  artwork_url: string | null;
  is_private: boolean;
  is_hidden: boolean;
}

export interface CollectionSummaryRow {
  collection_id: number;
  slug: string;
  title: string;
  description: string | null;
  type: string | null;
  year: number | null;
  updated_on: string;
  item_count: number;
  section_count: number;
  logo_object_key: string | null;
  banner_object_key: string | null;
  featured_on: string | null;
  verified_on: string | null;
}

export interface CollectionDetailRow extends CollectionSummaryRow {
  type_rank: number | null;
  owner_address: string | null;
  external_url: string | null;
  created_on: string;
  ui_collection_id: number | null;
  primary_color: string | null;
  highlight_color: string | null;
  dark_color: string | null;
  grey_color: string | null;
  white_color: string | null;
  is_visible_in_recent_list: number | null;
  toggle_poap_elements: number | null;
  verified_by: number | null;
  verifier_name: string | null;
  verifier_slug: string | null;
}

export interface CollectionUrlRow {
  url_id: number;
  url: string;
}

export interface CollectionMediaRow {
  role: string;
  object_key: string | null;
  content_type: string | null;
  byte_length: number | null;
  sha256: string | null;
  width: number | null;
  height: number | null;
  status: string;
  eligible_for_publish: number;
}

export interface CollectionSectionRow {
  section_id: string;
  name: string | null;
  position: number;
}

export interface CollectionArtistRow {
  artist_id: string;
  ens: string | null;
  name: string | null;
  slug: string | null;
  created_at: string;
}

export interface CollectionOrganizationRow {
  organization_id: number;
  name: string;
  slug: string;
  created_on: string;
}

export interface CollectionItemRow {
  item_id: number;
  created_on: string | null;
  drop_id: number;
  fancy_id: string | null;
  drop_title: string | null;
  drop_description: string | null;
  start_date: string | null;
  end_date: string | null;
  expiry_date: string | null;
  drop_year: number | null;
  city: string | null;
  country: string | null;
  event_url: string | null;
  image_object_key: string | null;
  is_virtual: number | null;
  private_value: string | null;
  is_hidden: number | null;
  channel: string | null;
  platform: string | null;
  location_type: string | null;
  timezone: string | null;
  integrator_id: string | null;
  created_date: string | null;
  token_count: number | null;
  transfer_count: number | null;
  email_claims_minted: number | null;
  email_claims_reserved: number | null;
  email_claims_total: number | null;
  drop_featured_on: string | null;
  moments_uploaded: number | null;
}

export interface CollectionDropStatsRow {
  drop_id: number;
  card_drop_id: number | null;
  private_value: string | null;
  is_hidden: number | null;
  token_count: number | null;
  transfer_count: number | null;
  email_claims_minted: number | null;
  email_claims_reserved: number | null;
  email_claims_total: number | null;
  drop_featured_on: string | null;
  moments_uploaded: number | null;
}

export interface CollectionDropStatsByChainRow {
  drop_id: number;
  chain: string | null;
  created_on: number | null;
  poap_count: number;
  transfer_count: number;
}

export interface CollectionItemSectionRow {
  item_id: number;
  section_id: string;
  position: number;
}

export interface CollectionSummary {
  collectionId: number;
  slug: string;
  title: string;
  description: string | null;
  type: Exclude<CollectionType, "all"> | null;
  year: number | null;
  updatedOn: string;
  itemCount: number;
  sectionCount: number;
  logoUrl: string | null;
  bannerUrl: string | null;
  isFeatured: boolean;
  isVerified: boolean;
}

export interface CollectionRecord extends CollectionSummary {
  typeRank: number | null;
  ownerAddress: string | null;
  externalUrl: string | null;
  createdOn: string;
  featuredOn: string | null;
  verification: {
    organizationId: number;
    organizationName: string;
    organizationSlug: string;
    verifiedOn: string;
  } | null;
}

export interface CollectionArtist {
  artistId: string;
  ens: string | null;
  name: string | null;
  slug: string | null;
  createdAt: string;
}

export interface CollectionOrganization {
  organizationId: number;
  name: string;
  slug: string;
  createdOn: string;
}

export interface CollectionUiSettings {
  primaryColor: string | null;
  highlightColor: string | null;
  darkColor: string | null;
  greyColor: string | null;
  whiteColor: string | null;
  isVisibleInRecentList: boolean;
  togglePoapElements: boolean;
}

export interface CollectionMedia {
  role: "logo" | "banner" | "mobile_banner" | "social";
  objectUrl: string | null;
  contentType: string | null;
  byteLength: number | null;
  sha256: string | null;
  width: number | null;
  height: number | null;
  status: "pending" | "stored" | "missing" | "quarantined" | "failed";
  eligibleForPublish: boolean;
}

export interface CollectionSection {
  sectionId: string;
  name: string | null;
  position: number;
}

export interface CollectionHiddenDropCard {
  dropId: number;
  isHidden: true;
}

export interface CollectionPrivateDropCard {
  dropId: number;
  isPrivate: true;
}

export interface CollectionVisibleDropCard {
  dropId: number;
  fancyId: string;
  title: string;
  description: string | null;
  startDate: string;
  endDate: string;
  expiryDate: string | null;
  year: number;
  city: string | null;
  country: string | null;
  eventUrl: string | null;
  imageUrl: string | null;
  isVirtual: boolean | null;
  isPrivate: false;
  isHidden: false;
  channel: string | null;
  platform: string | null;
  locationType: string | null;
  timezone: string | null;
  integratorId: string | null;
  createdDate: string;
  tokenCount: number | null;
  transferCount: number;
  emailClaims: {
    minted: number | null;
    reserved: number | null;
    total: number | null;
  } | null;
  featuredOn: string | null;
  momentsUploaded: number | null;
}

export type CollectionDropCard =
  CollectionHiddenDropCard | CollectionPrivateDropCard | CollectionVisibleDropCard;

export interface CollectionItem {
  itemId: number;
  createdOn: string | null;
  sections: Array<{ sectionId: string; position: number }>;
  drop: CollectionDropCard | null;
}

export interface CollectionItemsPage {
  collectionId: number;
  total: number;
  items: CollectionItem[];
  nextCursor: string | null;
}

export interface CollectionArtistDrop {
  artistId: string;
  dropId: number;
  drop: CollectionDropCard | null;
}

export interface CollectionSuggestion {
  suggestionId: number;
  dropId: number;
  suggestedBy: string | null;
  createdOn: string;
  drop: CollectionDropCard | null;
}

export interface CollectionArtistDropsPage {
  collectionId: number;
  items: CollectionArtistDrop[];
  nextCursor: string | null;
}

export interface CollectionSuggestionsPage {
  collectionId: number;
  items: CollectionSuggestion[];
  nextCursor: string | null;
}

export interface CollectionVisibleDropStats {
  dropId: number;
  isPrivate: false;
  isHidden: false;
  tokenCount: number | null;
  transferCount: number;
  emailClaims: {
    minted: number | null;
    reserved: number | null;
    total: number | null;
  } | null;
  featuredOn: string | null;
  momentsUploaded: number | null;
  byChain: Array<{
    chain: string | null;
    createdOn: number | null;
    poapCount: number;
    transferCount: number;
  }>;
}

export type CollectionDropStats =
  | { dropId: number }
  | CollectionHiddenDropCard
  | CollectionPrivateDropCard
  | CollectionVisibleDropStats;

export interface CollectionDropStatsPage {
  collectionId: number;
  items: CollectionDropStats[];
  nextCursor: string | null;
}

export interface CollectionProfile {
  snapshotId: string;
  collection: CollectionRecord;
  urls: Array<{ urlId: number; url: string | null }>;
  uiSettings: CollectionUiSettings | null;
  media: CollectionMedia[];
  sections: CollectionSection[];
  artists: CollectionArtist[];
  organizations: CollectionOrganization[];
}
