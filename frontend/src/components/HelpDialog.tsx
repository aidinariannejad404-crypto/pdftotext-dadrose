import Modal from './Modal';

const SHORTCUTS: [string, string][] = [
  ['Ctrl + Enter', 'تأیید و رفتن به مورد بعدی'],
  ['F8 یا Alt + N', 'رفتن به سؤال (یا صفحه‌ی) بعدی که مشکل دارد'],
  ['Alt + ↓ / Alt + ↑', 'سؤال یا صفحه‌ی بعدی / قبلی'],
  ['Ctrl + S', 'ذخیره‌ی فوری (ذخیره خودکار هم انجام می‌شود)'],
  ['Ctrl + چرخ ماوس', 'بزرگ‌نمایی تصویر صفحه'],
  ['?', 'باز کردن همین راهنما'],
];

export default function HelpDialog({ onClose, mode = 'questions' }: { onClose: () => void; mode?: 'questions' | 'text' }) {
  return (
    <Modal
      title="راهنمای بازبینی"
      onClose={onClose}
      wide
      footer={
        <button className="btn btn-primary" onClick={onClose}>
          متوجه شدم
        </button>
      }
    >
      <section className="help-section">
        <h3>روند کار</h3>
        {mode === 'text' ? (
          <ol className="help-steps">
            <li>متن هر صفحه را با تصویر آن (سمت چپ) مقایسه و اشتباهات را اصلاح کنید. تغییرات خودکار ذخیره می‌شوند.</li>
            <li>«تأیید و صفحه‌ی بعد» را بزنید. با «صفحه‌ی مشکوک بعدی» به صفحه‌هایی بروید که کلمه‌ی مشکوک دارند.</li>
            <li>وقتی همه‌ی صفحه‌ها تأیید شد، «دانلود فایل Word» را بزنید تا متن کامل را داشته باشید.</li>
          </ol>
        ) : (
        <ol className="help-steps">
          <li>هر سؤال را با تصویر صفحه (سمت چپ) مقایسه کنید و اشتباهات متن را اصلاح کنید.</li>
          <li>دایره‌ی کنار پاسخ درست را انتخاب کنید و «تأیید و بعدی» را بزنید. تغییرات خودکار ذخیره می‌شوند.</li>
          <li>وقتی همه تأیید شد، «دانلود فایل Word» را بزنید و فایل را در پنل سایت در «ورود هوشمند از ورد» بارگذاری کنید.</li>
        </ol>
        )}
      </section>
      <section className="help-section">
        <h3>معنی رنگ‌ها</h3>
        <ul className="help-legend">
          <li><i className="dot dot-approved" /> سبز: سؤال تأیید شده است.</li>
          <li><i className="dot dot-error" /> قرمز: سؤال خطا دارد (مثلاً پاسخ درست یا یک گزینه مشخص نیست) و باید اصلاح شود.</li>
          <li><i className="dot dot-warning" /> نارنجی: نیاز به بررسی دارد (مثلاً کلمه‌ی مشکوک).</li>
          <li><i className="dot dot-neutral" /> خاکستری: هنوز تأیید نشده، ولی مشکلی دیده نشد.</li>
          <li><mark className="hl-mark hl-disagree help-mark">کلمه</mark> زرد: دو روش خواندن، این کلمه را متفاوت خوانده‌اند.</li>
          <li><mark className="hl-mark hl-low_conf help-mark">کلمه</mark> صورتی: این کلمه در تصویر خوانا نبوده است.</li>
        </ul>
      </section>
      <section className="help-section">
        <h3>مقایسه با تصویر</h3>
        <ul className="help-list">
          <li>کادر آبی روی تصویر، محل سؤال فعلی را نشان می‌دهد.</li>
          <li>نشانگر ماوس را روی هر کلمه‌ی تصویر نگه دارید تا متن خوانده‌شده و میزان اطمینان آن را ببینید. با کلیک روی کلمه، همان کلمه در متن انتخاب می‌شود.</li>
          <li>روی کلمه‌های مشکوک بزنید تا هم در متن و هم روی تصویر مشخص شوند؛ سپس یکی از دو خوانش را انتخاب کنید.</li>
          <li>«تصویر اصلی» عکس خام اسکن را نشان می‌دهد (بدون کادرها) — برای وقتی که تصویر پردازش‌شده ناخواناست.</li>
        </ul>
      </section>
      <section className="help-section">
        <h3>میانبرهای صفحه‌کلید</h3>
        <table className="help-keys">
          <tbody>
            {SHORTCUTS.map(([k, v]) => (
              <tr key={k}>
                <td>
                  <kbd>{k}</kbd>
                </td>
                <td>{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </Modal>
  );
}
