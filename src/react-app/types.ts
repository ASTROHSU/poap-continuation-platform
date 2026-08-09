export interface ArchiveCounts {
  drops: number;
  tokens: number;
  owners: number;
  artworks: number;
}

export interface AppConfig {
  mode: "combined" | "live-only";
  walletProvisioning: WalletProvisioningConfig;
}

export interface WalletProvisioningConfig {
  mode: "disabled" | "magic-pregen";
  enabled: boolean;
  publishableKey: string | null;
}

export interface EmailWallet {
  provider: "magic-pregen";
  status: "provisioning" | "ready" | "failed";
  address: `0x${string}` | null;
  updatedAt: string;
}

export interface EmailWalletResponse {
  config: WalletProvisioningConfig;
  wallet: EmailWallet | null;
}

export interface ArchiveMeta {
  snapshotId: string;
  snapshotAt: string;
  holdingsSnapshotId?: string;
  holdingsSnapshotAt?: string;
  counts: ArchiveCounts;
  years: number[];
}

export interface CollectionsMeta {
  snapshotId: string;
  releaseId: string;
  snapshotAt: string;
  count: number;
}

export interface MomentsMeta {
  snapshotId: string;
  snapshotAt: string;
  counts: {
    sourceMoments: number;
    publicMoments: number;
    media: number;
    capsules: number;
  };
}

export interface AddressResolution {
  name: string;
  address: string;
}

export interface LiveEvent {
  eventId: string;
  slug: string;
  title: string;
  description: string;
  imageUrl: string;
  eventUrl: string | null;
  startsAt: string;
  claimOpensAt: string;
  claimClosesAt: string;
  chainId: number;
  contractAddress: string | null;
  tokenId: string | null;
  maxSupply: number;
  claimedCount: number;
  mintedCount: number;
  claimMode: "unique" | "shared";
  status: "draft" | "published" | "closed";
}

export interface LiveHolding extends LiveEvent {
  claimedAt: string;
  mintStatus: "reserved" | "minted";
  mintedTxHash: string | null;
  mintedAt: string | null;
  ownershipSource: "claim-record" | "chain-index";
  chainSyncedAt: string | null;
  chainFinalizedBlock: number | null;
}

export interface LiveHoldingsResponse {
  address: string;
  items: LiveHolding[];
}

export interface LiveClaimResponse {
  eventId: string;
  slug: string;
  address: string;
  claimedAt: string;
  mintStatus: "reserved" | "ready" | "minted";
  mintedTxHash: string | null;
  mintAuthorization: MintAuthorization | null;
}

export interface MintAuthorization {
  chainId: number;
  contractAddress: `0x${string}`;
  tokenId: string;
  account: `0x${string}`;
  deadline: number;
  nonce: `0x${string}`;
  signature: `0x${string}`;
}

export interface LiveMintResponse {
  eventId: string;
  slug: string;
  address: string;
  mintStatus: "minted";
  mintedAt: string;
  transactionHash: `0x${string}`;
  explorerUrl: string;
}

export interface LiveRelayResponse {
  eventId: string;
  slug: string;
  address: string;
  jobId: string | null;
  mintStatus: "minting" | "minted";
  transactionHash: `0x${string}` | null;
  explorerUrl: string | null;
}

export interface MintJobResponse {
  jobId: string;
  mintStatus: "minting" | "minted";
  transactionHash: `0x${string}` | null;
  explorerUrl: string | null;
}

export interface EmailReservation {
  reservationId: string;
  reservedAt: string;
  boundAddress: `0x${string}` | null;
  claimedAt: string | null;
  mintStatus: "reserved" | "ready" | "minted";
  mintedTxHash: `0x${string}` | null;
  mintedAt: string | null;
  event: LiveEvent;
}

export interface EmailReservationsResponse {
  items: EmailReservation[];
  walletConfig: WalletProvisioningConfig;
  wallet: EmailWallet | null;
}

export interface EmailChallengeResponse {
  status: "verification_sent";
  debugMagicLink?: string;
}

export interface EmailVerificationResponse {
  purpose: "reserve" | "login";
  reservation: EmailReservation | null;
  wallet: EmailWallet | null;
  redirectTo: string;
}

export interface EmailBindResponse extends EmailReservation {
  mintAuthorization: MintAuthorization | null;
}

export interface Drop {
  dropId: number;
  fancyId?: string | null;
  title: string;
  description?: string | null;
  startDate: string;
  endDate?: string | null;
  expiryDate?: string | null;
  city?: string | null;
  country?: string | null;
  year: number;
  isVirtual?: boolean | null;
  eventUrl?: string | null;
  channel?: string | null;
  platform?: string | null;
  locationType?: string | null;
  timezone?: string | null;
  integratorId?: string | null;
  createdAt?: string | null;
  imageUrl: string;
  hasArtwork?: boolean;
  tokenCount?: number;
  reservationsTotal?: number;
  reservationsMinted?: number;
  reservationsUnminted?: number;
  dropTransferCount?: number;
  featuredOn?: string | null;
  momentsUploaded?: number | null;
  /** Included for exact-ID and exact-address responses, never browse results. */
  isPrivate?: true;
  /** Included for exact-ID and exact-address responses, never browse results. */
  isHidden?: true;
}

export interface Holding extends Drop {
  sourceUid: string;
  poapId: number;
  mintedOn?: number | null;
  ownerAddress: string;
  network: string;
  transferCount: number;
}

export interface DropCollector {
  poapId: number;
  ownerAddress: string;
  mintedOn: number | null;
  network: string;
  transferCount: number;
}

export interface DropCollectorsPage extends PageResponse<DropCollector> {
  snapshotId: string;
  dropId: number;
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

export interface PageResponse<T> {
  items: T[];
  nextCursor: string | null;
}

export interface OwnerPageResponse extends PageResponse<Holding> {
  address: string;
  total: number;
  uniqueDrops?: number;
}

export type DropSort = "recent" | "oldest" | "popular";
export type EventType = "all" | "virtual" | "in-person";

export type CollectionType = "all" | "artist" | "organization" | "user";

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
  | { dropId: number; isHidden: true }
  | { dropId: number; isPrivate: true }
  | CollectionVisibleDropCard;

export interface CollectionItem {
  itemId: number;
  createdOn: string | null;
  sections: Array<{ sectionId: string; position: number }>;
  drop: CollectionDropCard | null;
}

export interface CollectionItemsPage extends PageResponse<CollectionItem> {
  collectionId: number;
  total: number;
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

export interface CollectionDetailResponse extends CollectionProfile {
  items: CollectionItemsPage;
}

export type CollectionExportSegmentName =
  "metadata" | "items" | "artist-drops" | "suggestions" | "drop-stats";

export interface CollectionExportManifest {
  schemaVersion: "poapin-collection-export-v1";
  snapshotId: string;
  releaseId: string;
  collectionId: number;
  counts: {
    items: number;
    sections: number;
    urls: number;
    media: number;
    artistDrops: number;
    suggestions: number;
    dropStats: number;
  };
  segments: Array<{
    name: CollectionExportSegmentName;
    path: string;
    pagination: "none" | "cursor";
    count: number;
    pageSize?: number;
  }>;
}

export type MomentMediaKind = "image" | "video" | "audio" | "other";
export type MediaPreservationState = "none" | "pending" | "partial" | "complete";

export interface MomentMediaPreview {
  mediaId: string;
  kind: MomentMediaKind;
  mimeType: string | null;
  url: string;
  thumbnailUrl: string | null;
  width: number | null;
  height: number | null;
}

export interface MomentMedia extends MomentMediaPreview {
  byteLength: number | null;
  durationMs: number | null;
  position: number;
}

export interface MomentSummary {
  momentId: string;
  displayId: string | null;
  author: string | null;
  description: string | null;
  createdOn: string;
  updatedOn: string | null;
  isUpdated: boolean;
  sourceMediaCount: number;
  mediaCount: number;
  mediaPreservationState: MediaPreservationState;
  previewMedia: MomentMediaPreview | null;
  dropIds: number[];
  collectionIds: number[];
}

export interface MomentLinkRecord {
  linkId: string;
  title: string | null;
  description: string | null;
  url: string | null;
  imageUrl: string | null;
  createdOn: string | null;
}

export interface MomentUserTag {
  tagId: string;
  address: string | null;
  ens: string | null;
  x: number | null;
  y: number | null;
  createdOn: string | null;
}

export interface MomentCapsule {
  capsuleId: number;
  externalId: string | null;
  title: string | null;
  description: string | null;
  imageUrl: string | null;
  url: string | null;
  owner: string | null;
  createdOn: string;
}

export interface MomentDetail extends MomentSummary {
  cid: string | null;
  tokenId: string | null;
  media: MomentMedia[];
  links: MomentLinkRecord[];
  userTags: MomentUserTag[];
  capsules: MomentCapsule[];
}

export interface MomentsPageResponse extends PageResponse<MomentSummary> {
  snapshotId: string;
}

export interface MomentAuthorExportPage {
  schemaVersion: "poapin-moment-author-export-v1";
  snapshotId: string;
  releaseId: string;
  sourceDatabaseSha256: string;
  buildManifestSha256: string;
  author: string;
  items: MomentDetail[];
  nextCursor: string | null;
}

export interface MomentTaggedExportPage {
  schemaVersion: "poapin-moment-tagged-export-v1";
  snapshotId: string;
  releaseId: string;
  sourceDatabaseSha256: string;
  buildManifestSha256: string;
  address: string;
  items: MomentDetail[];
  nextCursor: string | null;
}

export interface CapsuleOwnerExportPage {
  schemaVersion: "poapin-capsule-owner-export-v1";
  snapshotId: string;
  releaseId: string;
  sourceDatabaseSha256: string;
  buildManifestSha256: string;
  address: string;
  items: MomentCapsule[];
  nextCursor: string | null;
}

export interface PersonalExportManifest {
  schemaVersion: "poapin-personal-export-v1";
  address: string;
  snapshots: {
    catalog?: string;
    holdings: string;
    collections: string;
    moments: string;
  };
  sources: {
    catalog?: {
      snapshotId: string;
    };
    holdings: {
      snapshotId: string;
    };
    collections: {
      snapshotId: string;
      releaseId: string;
    };
    moments: {
      snapshotId: string;
      releaseId: string;
      sourceDatabaseSha256: string;
      buildManifestSha256: string;
    };
  };
  counts: {
    holdings: number;
    authoredMoments: number;
    taggedMoments: number;
    ownedCollections: number;
    ownedCapsules: number;
  };
  segments: {
    holdings: { path: string; pageSize: number };
    ownedCollections: { path: string; pageSize: number };
    moments: { path: string; pageSize: number };
    taggedMoments: { path: string; pageSize: number };
    ownedCapsules: { path: string; pageSize: number };
  };
}

export interface PersonalHoldingsPage extends PageResponse<PersonalHoldingReference> {
  schemaVersion: "poapin-personal-holdings-page-v2";
  snapshotId: string;
  catalogSnapshotId?: string;
  collectionsSnapshotId: string;
  collectionsReleaseId: string;
  address: string;
  total: number;
  drops: Drop[];
  unavailableDropIds: number[];
}

export interface DropDetailBatchResponse {
  schemaVersion: "poapin-drop-detail-batch-v1";
  snapshotId: string;
  requestedDropIds: number[];
  drops: Drop[];
  unavailableDropIds: number[];
}

export interface HeldDropCollectionMembership {
  collection: CollectionSummary;
  matchedDropIds: number[];
}

export interface HeldDropCollectionMembershipsResponse {
  schemaVersion: "poapin-collection-memberships-v1";
  snapshotId: string;
  releaseId: string;
  requestedDropIds: number[];
  memberships: HeldDropCollectionMembership[];
}

export interface OwnedCollectionsPage extends PageResponse<CollectionSummary> {
  schemaVersion: "poapin-owned-collections-page-v1";
  snapshotId: string;
  releaseId: string;
  address: string;
}

export interface CollectionProfilesResponse {
  schemaVersion: "poapin-collection-profiles-v1";
  snapshotId: string;
  releaseId: string;
  profiles: CollectionProfile[];
}

export interface CollectionExportPage<T> extends PageResponse<T> {
  schemaVersion: "poapin-collection-export-v1";
  snapshotId: string;
  releaseId: string;
  segment: Exclude<CollectionExportSegmentName, "metadata">;
  collectionId: number;
  nextPath: string | null;
}
