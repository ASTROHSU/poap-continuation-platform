export type PublicMintProgress = "minting" | "minted";

export function mintProgressLabel(progress: PublicMintProgress): "正在鑄造" | "鑄造完成" {
  return progress === "minted" ? "鑄造完成" : "正在鑄造";
}
