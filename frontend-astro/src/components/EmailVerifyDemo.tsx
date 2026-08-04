import { useEffect, useState } from "react";
import { readableError, verifyEmail } from "../lib/live-api";

export default function EmailVerifyDemo() {
  const [status, setStatus] = useState<"checking" | "error">("checking");
  const [error, setError] = useState("");

  useEffect(() => {
    const token = new URLSearchParams(window.location.search).get("token");
    if (!token) {
      setStatus("error");
      setError("這個 Email 驗證連結不完整。");
      return;
    }
    verifyEmail(token)
      .then((result) => window.location.replace(result.redirectTo || "/email/collection"))
      .catch((problem) => {
        setError(readableError(problem));
        setStatus("error");
      });
  }, []);

  return (
    <div className="soft-card mx-auto max-w-xl rounded-[2.2rem] p-8 text-center sm:p-12">
      {status === "checking" ? (
        <>
          <span className="mx-auto block size-12 animate-spin rounded-full border-4 border-leaf/15 border-t-leaf" />
          <h1 className="mt-7 text-3xl font-bold">正在驗證 Email</h1>
          <p className="mt-3 text-ink/55">完成後會自動開啟你的收藏。</p>
        </>
      ) : (
        <>
          <span className="text-5xl">×</span>
          <h1 className="display-title mt-7 text-4xl">連結無效</h1>
          <p className="mt-3 text-ink/55">{error}</p>
          <a className="btn-primary mt-7" href="/email/collection">
            重新登入
          </a>
        </>
      )}
    </div>
  );
}
