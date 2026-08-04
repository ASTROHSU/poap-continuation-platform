import { useEffect, useMemo, useState } from "react";
import { verifyEmailMagicLink } from "../api";
import { Link, navigate } from "../router";
import { isAbortError } from "../utils";

export function EmailVerifyPage({ search }: { search: string }) {
  const token = useMemo(() => new URLSearchParams(search).get("token")?.trim() ?? "", [search]);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!token) {
      setError("驗證網址缺少必要資訊。");
      return;
    }
    const controller = new AbortController();
    verifyEmailMagicLink(token, controller.signal)
      .then((result) => navigate(result.redirectTo, { replace: true }))
      .catch((cause: unknown) => {
        if (!isAbortError(cause)) {
          setError(cause instanceof Error ? cause.message : "驗證失敗，請重新索取連結。");
        }
      });
    return () => controller.abort();
  }, [token]);

  return (
    <main className="claim-page shell" id="main-content" tabIndex={-1}>
      <section className="claim-panel glass-panel">
        <div>
          <span className="eyebrow">Email 驗證</span>
          <h1>{error ? "無法完成驗證" : "正在確認你的 Email…"}</h1>
          <p role="status">{error || "完成後會自動開啟你的保留收藏。"}</p>
          {error ? (
            <Link className="button button--gold" href="/email/collection">
              重新登入
            </Link>
          ) : null}
        </div>
      </section>
    </main>
  );
}
