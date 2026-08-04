export function LiveHelpPage() {
  return (
    <main className="about-page shell" id="main-content" tabIndex={-1}>
      <section className="about-hero">
        <span className="eyebrow">領取支援與隱私</span>
        <h1>保留必要資料，不保管你的錢包。</h1>
        <p>
          這個平台由兆量富足教育協會用於發行與呈現數位紀念章。以下說明領取時保存的資料、
          自助重試方式，以及需要人工協助時應提供哪些資訊。
        </p>
      </section>

      <section className="about-grid">
        <article className="about-card glass-panel">
          <span className="about-card__number">01</span>
          <h2>平台保存什麼</h2>
          <p>
            錢包地址、活動與領取狀態、鏈上交易雜湊，以及用於辨識 Email 預約的不可逆 HMAC。 Magic
            Link token 與 Session token 只保存雜湊；Email 只在短效驗證紀錄中加密保存。
          </p>
        </article>
        <article className="about-card glass-panel">
          <span className="about-card__number">02</span>
          <h2>保存多久</h2>
          <p>
            過期的 Magic Link 與 Email Session 在 24 小時復原緩衝後自動清除。已完成的活動、
            預約關係、公開錢包地址與交易紀錄會為了收藏呈現及活動對帳持續保存。
          </p>
        </article>
        <article className="about-card glass-panel">
          <span className="about-card__number">03</span>
          <h2>平台不會做什麼</h2>
          <p>
            平台不建立託管錢包、不保存私鑰或助記詞，也不會要求你把私鑰傳給協會。NFT 由你連接的既有
            Base 錢包持有；協會只代為送出交易並支付 Gas。轉移後收藏頁會依 finalized 鏈上事件更新。
          </p>
        </article>
      </section>

      <section className="principles">
        <div>
          <span className="eyebrow">遇到問題</span>
          <h2>先安全重試，再提供可公開核對的資料。</h2>
        </div>
        <div className="principles__copy">
          <p>
            RPC 暫時中斷或協會代付交易失敗時，可以回到原領取頁重新操作；短效鑄造授權可以重新取得，
            不會因此重複占用名額。交易已成功但收藏頁尚未更新時，先等待 finalized 區塊與下一次
            索引排程。
          </p>
          <p>
            仍需協助時，請直接回覆寄送領取連結的協會信件，附上活動名稱或 slug、公開錢包地址、
            transaction hash、畫面顯示的錯誤代碼與發生時間。不要寄送私鑰、助記詞、完整 Magic
            Link、Session Cookie 或尚未使用的領取網址。
          </p>
        </div>
      </section>

      <section className="rights-note glass-panel">
        <h2>鏈上資料是公開的。</h2>
        <p>
          Base 上的錢包地址、token 與轉移紀錄任何人都可以查詢；Email 並不寫入鏈上。如果希望
          查詢或處理平台保存的非鏈上個人資料，請透過上述協會聯絡管道提出。
        </p>
      </section>
    </main>
  );
}
