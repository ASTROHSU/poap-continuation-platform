import type {
  CollectionDropCard,
  CollectionExportManifest,
  CollectionItem,
  CollectionProfile,
  Drop,
  HeldDropCollectionMembership,
  MomentCapsule,
  MomentDetail,
  PersonalHoldingReference,
} from "../types";

export interface PortableSiteSnapshotIds {
  holdings: string;
  collections: string;
  moments: string;
}

export interface PortableSiteSources {
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
}

export interface PortableCollectionArtistDrop {
  artistId: string;
  dropId: number;
  drop: CollectionDropCard | null;
}

export interface PortableCollectionSuggestion {
  suggestionId: number;
  dropId: number;
  suggestedBy: string | null;
  createdOn: string;
  drop: CollectionDropCard | null;
}

export interface PortableCollectionVisibleDropStats {
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

export type PortableCollectionDropStats =
  | { dropId: number }
  | { dropId: number; isHidden: true }
  | { dropId: number; isPrivate: true }
  | PortableCollectionVisibleDropStats;

/**
 * A fully collected, cursor-free copy of every public collection export segment.
 * Empty optional source segments are represented by empty arrays.
 */
export interface PortableOwnedCollectionExport {
  manifest: CollectionExportManifest;
  profile: CollectionProfile;
  items: CollectionItem[];
  artistDrops: PortableCollectionArtistDrop[];
  suggestions: PortableCollectionSuggestion[];
  dropStats: PortableCollectionDropStats[];
}

export interface PortableSiteSnapshot {
  address: string;
  generatedAt?: string;
  snapshotIds: PortableSiteSnapshotIds;
  sources: PortableSiteSources;
  holdings: PersonalHoldingReference[];
  drops: Drop[];
  unavailableDropIds: number[];
  collectionProfiles: CollectionProfile[];
  heldDropMemberships: HeldDropCollectionMembership[];
  authoredMomentAssociations?: Array<{ collectionId: number; momentIds: string[] }>;
  taggedMomentAssociations?: Array<{ collectionId: number; momentIds: string[] }>;
  ownedCollectionExports: PortableOwnedCollectionExport[];
  publicAuthoredMoments: MomentDetail[];
  publicTaggedMoments: MomentDetail[];
  ownedCapsules: MomentCapsule[];
}

export type PortableSiteTab = "poaps" | "collections" | "owned" | "moments";

export type PortableSiteDatasetId =
  | "holdings"
  | "drops"
  | "unavailable-drop-references"
  | "collection-profiles"
  | "held-drop-memberships"
  | "authored-moment-associations"
  | "tagged-moment-associations"
  | "owned-collections"
  | "owned-collection-items"
  | "owned-collection-artist-drops"
  | "owned-collection-suggestions"
  | "owned-collection-drop-stats"
  | "moments-authored"
  | "moments-tagged"
  | "capsules";

export interface PortableSiteDatasetManifest {
  id: PortableSiteDatasetId;
  tab: PortableSiteTab;
  label: string;
  count: number;
  paths: string[];
}

export interface PortableSiteManifestFile {
  path: string;
  mimeType: string;
  bytes: number;
  count: number;
  sha256: string;
  payload?: {
    encoding: "base64url";
    mimeType: "application/json";
    bytes: number;
    sha256: string;
  };
}

export interface PortableSiteManifest {
  schemaVersion: "poapin-portable-site-v2";
  address: string;
  generatedAt: string | null;
  generator: {
    name: "POAPin";
    siteUrl: "https://poap.in";
    sourceUrl: "https://github.com/glorylab/poapin-archive";
  };
  snapshotIds: PortableSiteSnapshotIds;
  sources: PortableSiteSources;
  counts: {
    holdings: number;
    uniqueDrops: number;
    privateHeldDrops: number;
    unavailableDropReferences: number;
    collectionProfiles: number;
    heldDropMemberships: number;
    authoredMomentAssociations: number;
    taggedMomentAssociations: number;
    ownedCollections: number;
    ownedCollectionItems: number;
    ownedCollectionArtistDrops: number;
    ownedCollectionSuggestions: number;
    ownedCollectionDropStats: number;
    publicAuthoredMoments: number;
    publicTaggedMoments: number;
    ownedCapsules: number;
  };
  coverage: {
    mediaReferences: number;
    knownReferencedMediaBytes: number;
    unknownByteLengthReferences: number;
    taggedMomentsIncluded: true;
  };
  policies: {
    historicalSnapshot: true;
    claimsCurrentOwnership: false;
    collectionMembership: "collection-items-v1";
    media: {
      mode: "remote-references";
      baseUrl: "https://media.poap.in";
      bundled: false;
      autoplay: false;
    };
    robots: "noindex,nofollow";
  };
  datasets: PortableSiteDatasetManifest[];
  deployment: {
    maxFiles: 1_000;
    maxFileBytes: 5_242_880;
    dataChunkTargetBytes: 3_670_016;
  };
  integrity: {
    algorithm: "SHA-256";
    scope: "Every generated file except manifest.json";
  };
  files: PortableSiteManifestFile[];
}

export interface PortableSiteRuntimeManifest {
  schemaVersion: "poapin-portable-runtime-v1";
  address: string;
  generatedAt: string | null;
  snapshotIds: PortableSiteSnapshotIds;
  sources: PortableSiteSources;
  counts: PortableSiteManifest["counts"];
  datasets: PortableSiteDatasetManifest[];
  files: Array<
    Pick<PortableSiteManifestFile, "path" | "count"> & {
      payload: NonNullable<PortableSiteManifestFile["payload"]>;
    }
  >;
}

export interface PortableSiteFile extends PortableSiteManifestFile {
  content: string;
}

export interface PortableSiteBuild {
  manifest: PortableSiteManifest;
  files: PortableSiteFile[];
}
