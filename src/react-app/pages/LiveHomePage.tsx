import { type FormEvent, useState } from "react";
import { ArrowIcon, SearchIcon } from "../icons";
import { Link, navigate } from "../router";
import { DEMO_WALLET_ADDRESS, isDemoMode, resetDemoState } from "../demo-api";

const ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;

export function LiveHomePage() {
  const [address, setAddress] = useState("");
  const [error, setError] = useState("");
  const demo = isDemoMode();

  const openCollection = (event: FormEvent) => {
    event.preventDefault();
    const value = address.trim();
    if (!ADDRESS_PATTERN.test(value)) {
      setError("請輸入包含 40 個十六進位字元的完整 0x 錢包地址。");
      return;
    }
    navigate(`/address/${value.toLowerCase()}`);
  };

  return (
    <main className="home-page" id="main-content" tabIndex={-1}>
      <section className="hero shell" id="address" tabIndex={-1}>
        <div className="hero__copy">
          <span className="eyebrow">兆量富足教育協會</span>
          <h1>
            活動的參與，
            <br />
            <em>由你永久收藏。</em>
          </h1>
          <p>領取協會發行的 Base 鏈上數位紀念章，或用錢包地址查看目前持有的收藏。</p>
          <div className="hero__actions">
            <Link className="button button--gold" href="/email/collection">
              查看 Email 保留收藏
            </Link>
            <Link className="button button--ghost" href="/help">
              領取支援與隱私
            </Link>
            {demo ? (
              <button
                className="button button--ghost"
                type="button"
                onClick={() => {
                  resetDemoState();
                  setAddress("");
                  window.location.href = "/";
                }}
              >
                重設展示資料
              </button>
            ) : null}
          </div>
        </div>

        <form className="hero__lookup glass-panel" onSubmit={openCollection} noValidate>
          <label htmlFor="live-address-lookup">查看錢包收藏</label>
          <div className={error ? "lookup-input has-error" : "lookup-input"}>
            <SearchIcon aria-hidden="true" />
            <input
              id="live-address-lookup"
              type="text"
              value={address}
              onChange={(event) => {
                setAddress(event.target.value);
                if (error) setError("");
              }}
              placeholder="0x 錢包地址"
              maxLength={42}
              autoComplete="off"
              spellCheck={false}
              autoCapitalize="none"
              autoCorrect="off"
              aria-invalid={error ? "true" : undefined}
              aria-describedby={error ? "live-address-error" : "live-address-help"}
            />
            <button className="button button--gold" type="submit">
              查看收藏
              <ArrowIcon />
            </button>
          </div>
          <span className="search-hint" id="live-address-help">
            {demo ? (
              <>
                體驗用地址：
                <button
                  type="button"
                  className="text-button"
                  onClick={() => setAddress(DEMO_WALLET_ADDRESS)}
                >
                  {DEMO_WALLET_ADDRESS}
                </button>
              </>
            ) : (
              "查詢不需要連接錢包，也不會要求簽名。"
            )}
          </span>
          {error ? (
            <span className="lookup-error" id="live-address-error" role="alert">
              {error}
            </span>
          ) : null}
        </form>
      </section>

      <section className="home-preview shell" aria-labelledby="pilot-flow-heading">
        <div className="section-heading">
          <div>
            <span className="eyebrow">簡單的領取流程</span>
            <h2 id="pilot-flow-heading">一個連結，兩種領取方式</h2>
          </div>
        </div>
        <div className="principle-grid">
          <article className="glass-panel">
            <strong>現在綁定錢包</strong>
            <p>打開活動連結、連接既有錢包，完成後直接鑄造並在收藏頁查看。</p>
          </article>
          <article className="glass-panel">
            <strong>先用 Email 保留</strong>
            <p>還沒有準備好錢包也沒關係；先保留資格，日後再綁定既有錢包。</p>
          </article>
          <article className="glass-panel">
            <strong>自己掌握收藏</strong>
            <p>鑄造完成後，鏈上所有權屬於收藏者使用的地址，不依賴本網站帳號。</p>
          </article>
        </div>
      </section>
    </main>
  );
}
