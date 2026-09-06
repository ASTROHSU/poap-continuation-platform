import { useEffect, useMemo, useState } from "react";
import {
  loginWithMagicEmail,
  logoutMagicEmailSession,
  resumeMagicEmailSession,
  type MagicEmbeddedSession,
} from "../lib/magic-wallet";
import { getAppConfig } from "../lib/live-api";

type Status = "draft" | "published" | "closed";

interface ManagedEvent {
  eventId: string;
  slug: string;
  title: string;
  issuer: string;
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
  claimMode: "unique" | "shared";
  status: Status;
  updatedAt: string;
  eventType: string;
  location: string;
  collaborators: string[];
}

interface ArtworkInput {
  name: string;
  type: string;
  dataUrl: string;
}

interface SavedResult {
  title: string;
  revisionId: string;
}

const blankMessage = { text: "", error: false };

export default function IssuerAdmin() {
  const [publishableKey, setPublishableKey] = useState("");
  const [emailTemplateName, setEmailTemplateName] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [session, setSession] = useState<MagicEmbeddedSession | null>(null);
  const [events, setEvents] = useState<ManagedEvent[]>([]);
  const [selectedSlug, setSelectedSlug] = useState("");
  const [event, setEvent] = useState<ManagedEvent | null>(null);
  const [artwork, setArtwork] = useState<ArtworkInput | null>(null);
  const [preview, setPreview] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(blankMessage);
  const [gasReport, setGasReport] = useState<{
    summary: string;
    csv: string;
    warning: string;
  } | null>(null);
  const [savedResult, setSavedResult] = useState<SavedResult | null>(null);

  const statusLabel = useMemo(() => {
    if (!event) return "";
    return event.status === "published" ? "開放中" : event.status === "closed" ? "已關閉" : "草稿";
  }, [event]);

  useEffect(() => {
    void (async () => {
      try {
        const config = await getAppConfig();
        const key = config.embeddedWallet.publishableKey || "";
        setPublishableKey(key);
        setEmailTemplateName(config.embeddedWallet.emailTemplateName);
        if (!key) return;
        const restored = await resumeMagicEmailSession(key);
        if (!restored) return;
        await verifyAdmin(restored);
        setSession(restored);
        setEmail(restored.email);
        await loadList(restored);
      } catch (error) {
        setMessage({ text: readable(error), error: true });
      }
    })();
  }, []);

  async function signIn() {
    await run(async () => {
      if (!publishableKey) throw new Error("Magic 管理者登入尚未啟用。");
      const next = await loginWithMagicEmail(publishableKey, email, emailTemplateName);
      await verifyAdmin(next);
      setSession(next);
      setEmail(next.email);
      await loadList(next);
      setMessage({ text: "登入成功，請選擇要管理的活動。", error: false });
    });
  }

  async function showGasReport() {
    if (!session) return;
    await run(async () => {
      const active = await freshSession(session);
      const data = await adminRequest<{
        notificationsConfigured: boolean;
        items: Array<{ summary: string | null; csv: string | null; lastErrorAt: number | null }>;
      }>("/api/admin/issuer/gas", active);
      const item = data.items[0];
      setGasReport({
        summary: item?.summary || "正在建立首次使用報表，請稍後重新整理。",
        csv: item?.csv || "",
        warning: item?.lastErrorAt
          ? "最近一次檢查未完成，下方是最後成功的報表。"
          : !data.notificationsConfigured
            ? "Telegram 收件設定尚未完成，目前不會發送提醒。"
            : "",
      });
    });
  }

  function downloadGasReport() {
    if (!gasReport?.csv) return;
    const url = URL.createObjectURL(new Blob([gasReport.csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "gas-usage.csv";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function signOut() {
    await run(async () => {
      await logoutMagicEmailSession(publishableKey);
      setSession(null);
      setGasReport(null);
      setEvents([]);
      setSelectedSlug("");
      setEvent(null);
      setSavedResult(null);
      setMessage(blankMessage);
    });
  }

  async function chooseEvent(slug: string) {
    setSavedResult(null);
    setSelectedSlug(slug);
    if (!slug || !session) {
      setEvent(null);
      return;
    }
    await run(async () => {
      const active = await freshSession(session);
      const response = await adminRequest<{ event: ManagedEvent }>(
        `/api/admin/issuer/events/${encodeURIComponent(slug)}`,
        active,
      );
      setEvent(response.event);
      setPreview(response.event.imageUrl);
      setArtwork(null);
      setMessage({ text: `已載入「${response.event.title}」。`, error: false });
    });
  }

  async function save() {
    if (!event || !session) return;
    await run(async () => {
      const active = await freshSession(session);
      const response = await adminRequest<{ event: ManagedEvent; revisionId: string }>(
        `/api/admin/issuer/events/${encodeURIComponent(event.slug)}`,
        active,
        {
          method: "PUT",
          body: JSON.stringify({
            slug: event.slug,
            expectedUpdatedAt: event.updatedAt,
            title: event.title,
            issuer: event.issuer,
            description: event.description,
            eventUrl: event.eventUrl,
            startsAt: event.startsAt,
            claimOpensAt: event.claimOpensAt,
            claimClosesAt: event.claimClosesAt,
            eventType: event.eventType,
            location: event.location,
            collaborators: event.collaborators,
            artwork,
          }),
        },
      );
      setEvent(response.event);
      setPreview(response.event.imageUrl);
      setArtwork(null);
      await loadList(active);
      setSavedResult({ title: response.event.title, revisionId: response.revisionId });
      setMessage(blankMessage);
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  }

  function returnToList() {
    setSavedResult(null);
    setSelectedSlug("");
    setEvent(null);
    setArtwork(null);
    setPreview("");
    setMessage({ text: "修改已完成，請選擇下一個要管理的活動。", error: false });
  }

  async function transition(status: "published" | "closed") {
    if (!event || !session) return;
    const action = status === "closed" ? "關閉活動並停止領取" : "重新開放領取";
    if (!window.confirm(`確定要${action}「${event.title}」嗎？`)) return;
    await run(async () => {
      const active = await freshSession(session);
      const response = await adminRequest<{ event: ManagedEvent; revisionId: string }>(
        `/api/admin/issuer/events/${encodeURIComponent(event.slug)}/status`,
        active,
        {
          method: "POST",
          body: JSON.stringify({ status, expectedUpdatedAt: event.updatedAt }),
        },
      );
      setEvent(response.event);
      await loadList(active);
      setMessage({ text: status === "closed" ? "活動已關閉。" : "活動已重新開放。", error: false });
    });
  }

  function patch<K extends keyof ManagedEvent>(key: K, value: ManagedEvent[K]) {
    setEvent((current) => (current ? { ...current, [key]: value } : current));
  }

  async function pickArtwork(file: File | undefined) {
    if (!file) return;
    if (file.size > 3 * 1024 * 1024) {
      setMessage({ text: "Artwork 不可超過 3 MiB。", error: true });
      return;
    }
    const dataUrl = await readDataUrl(file);
    setArtwork({ name: file.name, type: file.type, dataUrl });
    setPreview(dataUrl);
  }

  async function loadList(active: MagicEmbeddedSession) {
    const response = await adminRequest<{ items: ManagedEvent[] }>(
      "/api/admin/issuer/events",
      active,
    );
    setEvents(response.items);
  }

  async function freshSession(active: MagicEmbeddedSession) {
    const refreshed = await resumeMagicEmailSession(publishableKey);
    if (!refreshed || refreshed.email !== active.email) {
      throw new Error("管理者登入已逾時，請重新登入。");
    }
    setSession(refreshed);
    return refreshed;
  }

  async function run(task: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setMessage(blankMessage);
    try {
      await task();
    } catch (error) {
      setMessage({ text: readable(error), error: true });
    } finally {
      setBusy(false);
    }
  }

  if (!session) {
    return (
      <section className="soft-card mx-auto max-w-xl rounded-[2rem] p-7 sm:p-10">
        <span className="eyebrow">安全驗證 · 第 2 步</span>
        <h1 className="mt-6 font-display text-4xl font-black sm:text-5xl">活動管理者登入</h1>
        <p className="mt-4 leading-7 text-ink/58">
          Passkey／MFA 已通過。請再用管理者 Email 收取一次性驗證碼，完成第二層驗證。
        </p>
        <label className="mt-8 block text-sm font-black" htmlFor="issuer-admin-email">
          Email
        </label>
        <input
          id="issuer-admin-email"
          className="mt-2 w-full rounded-2xl border-2 border-purple/20 bg-white px-4 py-4 outline-none focus:border-purple"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(input) => setEmail(input.target.value)}
          onKeyDown={(key) => key.key === "Enter" && void signIn()}
          placeholder="name@example.com"
        />
        <button
          className="btn-primary mt-5 w-full justify-center"
          disabled={busy || !email.trim()}
          onClick={() => void signIn()}
        >
          {busy ? "正在驗證…" : "寄送驗證碼"}
        </button>
        {message.text && (
          <p
            className={`mt-5 rounded-2xl p-4 text-sm font-bold ${message.error ? "bg-pink-50 text-pink-800" : "bg-mint/30"}`}
          >
            {message.text}
          </p>
        )}
      </section>
    );
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[18rem_minmax(0,1fr)]">
      <aside className="soft-card h-fit rounded-[2rem] p-6 lg:sticky lg:top-28">
        <p className="text-xs font-black tracking-[.18em] text-purple">管理者</p>
        <p className="mt-2 truncate whitespace-nowrap font-bold" title={session.email}>
          {session.email}
        </p>
        <button
          className="btn-primary mt-5 w-full justify-center"
          disabled={busy}
          onClick={() => void showGasReport()}
        >
          Gas 餘額與使用報表
        </button>
        <label className="mt-7 block text-sm font-black" htmlFor="issuer-event-select">
          正式活動
        </label>
        <select
          id="issuer-event-select"
          className="mt-2 w-full rounded-2xl border-2 border-purple/20 bg-white px-3 py-3"
          value={selectedSlug}
          onChange={(input) => void chooseEvent(input.target.value)}
        >
          <option value="">選擇活動</option>
          {events.map((item) => (
            <option key={item.slug} value={item.slug}>
              {item.title} · {statusText(item.status)}
            </option>
          ))}
        </select>
        <a
          className="mt-5 block rounded-2xl border-2 border-purple/25 px-4 py-3 text-center text-sm font-black text-purple"
          href="/issuer/"
        >
          建立新活動設定
        </a>
        <button
          className="mt-4 w-full text-sm font-bold text-ink/45 underline underline-offset-4"
          onClick={() => void signOut()}
        >
          登出
        </button>
      </aside>

      <section>
        {gasReport && (
          <div className="soft-card mb-6 rounded-[2rem] p-6" aria-live="polite">
            <h2 className="text-xl font-black">Gas 餘額與使用報表</h2>
            {gasReport.warning && <p className="mt-3 font-bold text-purple">{gasReport.warning}</p>}
            <p className="mt-4 whitespace-pre-wrap break-words text-sm leading-7">
              {gasReport.summary}
            </p>
            {gasReport.csv && (
              <button className="btn-primary mt-4" onClick={downloadGasReport}>
                下載活動與日期明細 CSV
              </button>
            )}
          </div>
        )}
        {savedResult ? (
          <div
            className="soft-card rounded-[2rem] px-7 py-12 text-center sm:px-14 sm:py-16"
            role="status"
            aria-live="polite"
          >
            <div className="mx-auto grid size-20 place-items-center rounded-full border-4 border-purple bg-mint text-4xl font-black text-purple shadow-[8px_8px_0_rgba(124,114,226,.18)]">
              ✓
            </div>
            <span className="eyebrow mt-8 inline-block">修改完成</span>
            <h1 className="mt-5 font-display text-4xl font-black sm:text-5xl">正式資料已更新</h1>
            <p className="mx-auto mt-4 max-w-xl text-lg leading-8 text-ink/58">
              「{savedResult.title}」已成功儲存，公開活動資料與 metadata 均已更新。
            </p>
            <p className="mt-3 text-xs font-bold tracking-wide text-ink/35">
              版本 {savedResult.revisionId}
            </p>
            <button
              className="btn-primary mx-auto mt-9 w-full max-w-sm justify-center"
              disabled={busy}
              onClick={returnToList}
            >
              完成
            </button>
          </div>
        ) : !event ? (
          <div className="soft-card rounded-[2rem] p-9 text-center sm:p-14">
            <p className="text-5xl">✦</p>
            <h2 className="mt-5 font-display text-3xl font-black">選擇一個活動開始管理</h2>
            <p className="mt-3 text-ink/55">
              修改與狀態變更都會留下版本紀錄；鏈上 Token 不會被更換。
            </p>
          </div>
        ) : (
          <div className="space-y-6">
            <div className="soft-card rounded-[2rem] p-6 sm:p-9">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <span className="eyebrow">管理活動</span>
                  <h1 className="mt-5 font-display text-4xl font-black">{event.title}</h1>
                  <p className="mt-2 text-sm text-ink/45">
                    {event.slug} · Token #{event.tokenId || "尚未建立"}
                  </p>
                </div>
                <span className="whitespace-nowrap rounded-full bg-mint px-4 py-2 text-sm font-black">
                  {statusLabel}
                </span>
              </div>
            </div>

            <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_20rem]">
              <form
                className="soft-card rounded-[2rem] p-6 sm:p-9"
                onSubmit={(submit) => {
                  submit.preventDefault();
                  void save();
                }}
              >
                <Field label="活動名稱">
                  <input value={event.title} onChange={(i) => patch("title", i.target.value)} />
                </Field>
                <Field label="發行單位">
                  <input value={event.issuer} onChange={(i) => patch("issuer", i.target.value)} />
                </Field>
                <Field label="紀念說明">
                  <textarea
                    rows={5}
                    value={event.description}
                    onChange={(i) => patch("description", i.target.value)}
                  />
                </Field>
                <div className="grid gap-5 sm:grid-cols-2">
                  <Field label="活動開始">
                    <input
                      type="datetime-local"
                      value={dateTimeLocal(event.startsAt)}
                      onChange={(i) => patch("startsAt", new Date(i.target.value).toISOString())}
                    />
                  </Field>
                  <Field label="開放領取">
                    <input
                      type="datetime-local"
                      value={dateTimeLocal(event.claimOpensAt)}
                      onChange={(i) =>
                        patch("claimOpensAt", new Date(i.target.value).toISOString())
                      }
                    />
                  </Field>
                </div>
                <Field label="結束領取">
                  <input
                    type="datetime-local"
                    value={dateTimeLocal(event.claimClosesAt)}
                    onChange={(i) => patch("claimClosesAt", new Date(i.target.value).toISOString())}
                  />
                </Field>
                <div className="grid gap-5 sm:grid-cols-2">
                  <Field label="活動形式">
                    <input
                      value={event.eventType}
                      onChange={(i) => patch("eventType", i.target.value)}
                    />
                  </Field>
                  <Field label="地點">
                    <input
                      value={event.location}
                      onChange={(i) => patch("location", i.target.value)}
                    />
                  </Field>
                </div>
                <Field label="合作單位">
                  <input
                    value={event.collaborators.join("、")}
                    onChange={(i) =>
                      patch(
                        "collaborators",
                        i.target.value
                          .split(/[、,，]/)
                          .map((part) => part.trim())
                          .filter(Boolean),
                      )
                    }
                  />
                </Field>
                <Field label="活動網址">
                  <input
                    type="url"
                    value={event.eventUrl || ""}
                    onChange={(i) => patch("eventUrl", i.target.value || null)}
                    placeholder="https://"
                  />
                </Field>
                <Field label="更換 Artwork">
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/gif"
                    onChange={(i) => void pickArtwork(i.target.files?.[0])}
                  />
                  <small>不更換可留白；支援 PNG、JPEG、WebP、GIF，最大 3 MiB。</small>
                </Field>
                <button
                  className="btn-primary mt-8 w-full justify-center"
                  disabled={busy}
                  type="submit"
                >
                  {busy ? "正在儲存…" : "儲存修改並更新正式資料"}
                </button>
              </form>

              <aside className="space-y-6">
                <div className="soft-card rounded-[2rem] p-6 text-center">
                  <img
                    className="mx-auto aspect-square w-full rounded-full border-4 border-purple/20 object-cover"
                    src={preview || event.imageUrl}
                    alt="Artwork 預覽"
                  />
                  <h2 className="mt-5 font-display text-2xl font-black">{event.title}</h2>
                  <p className="mt-2 text-sm text-ink/50">{event.issuer}</p>
                </div>
                <div className="soft-card rounded-[2rem] p-6">
                  <p className="text-sm font-black">不可變的鏈上欄位</p>
                  <dl className="mt-4 min-w-0 space-y-3 text-sm text-ink/58">
                    <div>
                      <dt className="font-bold text-ink">網路</dt>
                      <dd>Base · {event.chainId}</dd>
                    </div>
                    <div className="min-w-0">
                      <dt className="font-bold text-ink">合約</dt>
                      <dd
                        className="truncate whitespace-nowrap font-mono text-xs"
                        title={event.contractAddress || "尚未建立"}
                      >
                        {event.contractAddress || "尚未建立"}
                      </dd>
                    </div>
                    <div>
                      <dt className="font-bold text-ink">Token</dt>
                      <dd>
                        #{event.tokenId || "—"} · {event.maxSupply} 份
                      </dd>
                    </div>
                  </dl>
                  {event.status === "closed" ? (
                    <button
                      className="mt-6 w-full rounded-2xl border-2 border-leaf bg-mint px-4 py-3 font-black"
                      disabled={busy}
                      onClick={() => void transition("published")}
                    >
                      重新開放領取
                    </button>
                  ) : (
                    <button
                      className="mt-6 w-full rounded-2xl border-2 border-pink-400 bg-pink-50 px-4 py-3 font-black text-pink-800"
                      disabled={busy}
                      onClick={() => void transition("closed")}
                    >
                      關閉並停止領取
                    </button>
                  )}
                </div>
              </aside>
            </div>
          </div>
        )}
        {message.text && (
          <p
            className={`mt-6 rounded-2xl p-4 text-sm font-bold ${message.error ? "bg-pink-50 text-pink-800" : "bg-mint/30"}`}
          >
            {message.text}
          </p>
        )}
      </section>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="mt-5 grid gap-2 text-sm font-black [&_input]:min-h-12 [&_input]:rounded-2xl [&_input]:border-2 [&_input]:border-purple/20 [&_input]:bg-white [&_input]:px-4 [&_input]:py-3 [&_textarea]:rounded-2xl [&_textarea]:border-2 [&_textarea]:border-purple/20 [&_textarea]:bg-white [&_textarea]:px-4 [&_textarea]:py-3 [&_small]:font-normal [&_small]:text-ink/45">
      <span>{label}</span>
      {children}
    </label>
  );
}

async function verifyAdmin(session: MagicEmbeddedSession) {
  await requestJson("/api/admin/issuer/session", {
    method: "POST",
    body: JSON.stringify({ didToken: session.didToken, email: session.email }),
  });
}

async function adminRequest<T>(
  path: string,
  session: MagicEmbeddedSession,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${session.didToken}`);
  headers.set("X-Issuer-Email", session.email);
  return requestJson<T>(path, { ...init, headers });
}

async function requestJson<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  if (init.body) headers.set("Content-Type", "application/json");
  const response = await fetch(path, {
    ...init,
    headers,
    credentials: "same-origin",
    cache: "no-store",
  });
  const body = (await response.json().catch(() => null)) as { error?: unknown } | T | null;
  if (!response.ok) {
    const error = body as { error?: unknown } | null;
    throw new Error(
      typeof error?.error === "string" ? error.error : `請求失敗（${response.status}）`,
    );
  }
  return body as T;
}

function dateTimeLocal(value: string): string {
  const date = new Date(value);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function statusText(status: ManagedEvent["status"]): string {
  if (status === "published") return "開放領取";
  if (status === "closed") return "已關閉";
  return "草稿";
}

function readDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("無法讀取 Artwork。"));
    reader.readAsDataURL(file);
  });
}

function readable(error: unknown): string {
  return error instanceof Error ? error.message : "發生未預期的問題，請稍後再試。";
}
