# HANDOFF — MoC Management App

Tài liệu bàn giao cho app quản lý MoC (Management of Change) nội bộ nhà máy.
Cập nhật lần cuối: 2026-09-17.

## 1. App này là gì

Một ứng dụng web **1 file HTML duy nhất** (frontend tĩnh, host trên GitHub Pages), dữ liệu
đồng bộ qua một **Cloudflare Worker + KV** nhỏ (xem thư mục [`cloudflare/`](cloudflare/)).
Ban đầu được xây từ file Excel `2026_MoC Master List - Simplify.xlsx` (25 MoC + 40 Action
Plan + Agenda + Attendant thật), nhưng **dữ liệu mẫu đã bị xoá khỏi source** (xem mục 10.0)
để tránh lộ dữ liệu nội bộ khi repo GitHub công khai — dữ liệu thật giờ chỉ tồn tại trên
Cloudflare (mục 2) và trong file Excel gốc lưu cục bộ, không đẩy lên GitHub.

**File chính:** [`index.html`](index.html) (~2780 dòng, trước đây tên `MoC_Management_App.html`)
**Backend dữ liệu:** [`cloudflare/worker.js`](cloudflare/worker.js) + [`cloudflare/wrangler.toml`](cloudflare/wrangler.toml)
— xem mục 10 để deploy.
**Cách mở khi phát triển local:** double-click file, hoặc mở bằng Chrome/Edge. Vẫn hoạt
động 100% offline (chỉ dùng `localStorage`) nếu chưa kết nối Cloudflare ở tab Cài đặt.

## 2. Dữ liệu & đồng bộ nhiều máy

- Dữ liệu gồm 5 phần: `mocList` (Master List), `actionPlan`, `agenda`, `attendant`, `users`
  (mật khẩu riêng của từng Leader).
- **Lưu cục bộ**: mỗi lần thay đổi tự lưu vào `localStorage` của trình duyệt (key
  `moc_app_cache_v1`) — mất nếu xoá dữ liệu trình duyệt, nhưng vẫn phục hồi được từ
  Cloudflare khi tải lại trang (nếu đã kết nối).
- **Đồng bộ nhiều máy / nhiều người** (khuyến nghị dùng thật): vào tab **Dữ liệu & Cài đặt**
  (chỉ Admin thấy được) → nhập **Worker URL** (ví dụ
  `https://moc-data-api.xxx.workers.dev`) và **API key** → bấm "Kết nối". Cấu hình này lưu
  trong `localStorage` của từng trình duyệt (key `moc_app_cloud_v1`) — mỗi máy chỉ cần nhập
  1 lần. Sau khi kết nối, mọi thao tác lưu sẽ gọi `PUT /data` lên Worker; Worker đọc dữ liệu
  đang lưu trong KV, merge theo `updatedAt` (giống cách merge file JSON trước đây) rồi ghi
  đè — nên nhiều người sửa cùng lúc trên các máy khác nhau không bị mất dữ liệu của nhau. App
  cũng tự `GET /data` mỗi 25 giây để lấy thay đổi từ người khác.
- Chưa kết nối Cloudflare → app chỉ dùng `localStorage`, có nút Xuất/Nhập JSON thủ công để
  backup/khôi phục ở tab Cài đặt (vẫn giữ nguyên, không đổi).
- Nút **"Lưu ngay"** (hoặc Ctrl+S) ép lưu ngay lập tức thay vì chờ debounce ~1.2s.
- ⚠️ File `moc_data.json` và cơ chế File System Access API (mở/tạo file trên OneDrive) của
  bản cũ **đã bị loại bỏ** — không còn dùng nữa, thay bằng Cloudflare Worker ở trên.

## 3. Tài khoản & phân quyền

| Vai trò | Cách đăng nhập | Quyền |
|---|---|---|
| **Chưa đăng nhập** | — | Chỉ xem (Xem MoC/Action, xem báo cáo), không sửa/xoá được gì |
| **Leader** | Chọn tên trong dropdown (lấy từ danh sách Attendant) + mật khẩu | Thêm mới mọi loại bản ghi; **chỉ sửa được MoC mà mình là Change Owner hoặc có tên trong Relevant People**; không xoá được; không vào được tab Cài đặt |
| **Admin** | Mật khẩu cố định | Toàn quyền: sửa/xoá mọi thứ, quản lý file dữ liệu, reset, backup |

- **Mật khẩu Admin**: `QAILD` (hằng số `CONFIG.adminPassword` trong code, dòng ~655).
- **Mật khẩu Leader mặc định = đúng tên hiển thị của họ** (không phân biệt hoa/thường).
  Sau khi đăng nhập, Leader có thể tự đổi mật khẩu bằng nút "Đổi mật khẩu" ở góc phải; mật
  khẩu mới lưu trong `state.data.users` (đồng bộ qua file chung như dữ liệu khác).
- ⚠️ Đây chỉ là lớp nhận diện nhẹ cho nội bộ, **không phải bảo mật thật** — mật khẩu nằm
  trong mã nguồn/file JSON dạng thường, ai mở file cũng đọc được.
- Lớp bảo vệ **thật sự** khi app đã public trên internet là **API key của Cloudflare Worker**
  (mục 10) — key này KHÔNG nằm trong `index.html` (khác với mật khẩu Admin/
  Leader), chỉ người được cấp key mới đọc/ghi được dữ liệu qua Worker.
- So khớp tên người (Change Owner / Relevant People) bỏ qua dấu tiếng Việt và hoa/thường
  (hàm `normalizeNameForMatch`) vì dữ liệu gốc ghi tên không nhất quán ("Vu Tran" / "Vũ Trần").

## 4. Bản đồ tính năng theo tab

- **Dashboard** — KPI tổng quan, donut trạng thái, bar theo Dept/Nature, top action sắp/đã trễ hạn.
- **Master List** — CRUD MoC đầy đủ theo 6 bước (Definition, Risk & Action, Approval, →
  Action Plan, Verification). Mặc định ẩn Done/Cancel (có checkbox bật lại). Có nút **Xem**
  (chỉ đọc, luôn hiện) tách riêng khỏi **Sửa** (theo quyền). Gợi ý tự động mã MoC
  (`MoC-<Dept>.<Năm>.<STT>`, cộng dồn theo Dept+Năm, không phân biệt hoa/thường). Gợi ý
  Change Owner/Relevant People từ dữ liệu đã có. Nút **"Gửi Email báo cáo"** (xem mục 5).
- **Action Plan** — theo dõi hành động (Issue/Action/PIC/Due date/Status), ẩn bớt cột
  MoC code/Partner/Function/Complete date khi hiển thị (đầy đủ trong Xuất CSV và form chi tiết).
- **Agenda & Attendant** — agenda họp định kỳ; bảng điểm danh W1–W52, **3 cột Name/Function/
  Requirement cố định (sticky)** khi cuộn ngang, tự cuộn tới đúng tuần hiện tại khi mở tab.
- **Dữ liệu & Cài đặt** (chỉ Admin) — kết nối Cloudflare Worker (URL + API key), backup/khôi
  phục JSON, reset về dữ liệu mẫu gốc.

Điều khiển **cỡ chữ trình chiếu** (A−/A+ 5 mức từ thường đến cực lớn + nút Đậm) ở góc trên,
lưu riêng theo từng máy — dùng khi chiếu màn hình lớn trong họp.

## 5. Tính năng "Gửi Email báo cáo" (ở tab Master List)

Vì trang HTML tĩnh **không thể tự gửi email** (không có mail server), nút này:
1. Tự động **tải về file `.eml`** (bản nháp email chuẩn RFC822, có `X-Unsent: 1` để Outlook
   mở ra ở chế độ soạn thảo) — mở file đó, điền/kiểm tra người nhận rồi bấm Gửi như bình thường.
2. Nội dung gồm: banner tiêu đề, KPI tổng quan, **biểu đồ PNG vẽ bằng Canvas** (donut trạng
   thái + bar theo Nature of change, tự tính chiều cao theo dữ liệu để không bao giờ bị
   tràn/cắt hình), bảng MoC đang theo dõi (theo đúng bộ lọc Master List đang áp dụng), bảng
   Action đang theo dõi (theo đúng bộ lọc hiện tại của tab Action Plan), **điểm danh tuần
   hiện tại kèm nhắc nhở người vắng/trễ**.
3. Nút phụ: "Sao chép nội dung" (copy HTML+text vào clipboard để dán trực tiếp vào Outlook/
   Gmail, giữ nguyên bảng và ảnh) và "Mở bằng mailto:" (chỉ gửi được text thuần, không có ảnh).

## 6. Kiến trúc mã nguồn (map nhanh theo số dòng, có thể lệch nhẹ khi sửa thêm)

```
633   CONFIG                — danh mục Dept/Status/Nature/Type, vai trò duyệt, mật khẩu admin
665   UTILS                 — uuid, format ngày, debounce, CSV, toast...
723   PRESENTATION MODE     — cỡ chữ/đậm cho trình chiếu
756   STORAGE               — cloud API (Cloudflare Worker) + localStorage cache
872   STATE                 — state toàn cục
893   AUTH / PERMISSIONS    — canEdit/canDelete/canEditMoc, đăng nhập, đổi mật khẩu
1102  SYNC STATUS UI
1112  SAVE / LOAD PIPELINE  — saveData(), merge theo updatedAt, refreshFromCloud() mỗi 25s
1207  INIT STORAGE
~1250 NAVIGATION            — switchView(), renderActiveView()
~1279 DASHBOARD RENDER
1373  MASTER LIST RENDER
1443  PEOPLE SUGGESTIONS    — datalist gợi ý tên người
1465  MOC FORM MODAL        — form 6 bước, approval động theo Nature
~1796 ACTION PLAN
~1917 AGENDA
~1980 ATTENDANT             — sticky cột, tự cuộn tuần hiện tại
2032  EXPORT CSV
2057  EMAIL REPORT          — vẽ chart, build HTML/text, xuất .eml
2569  SETTINGS               — kết nối/ngắt Cloudflare, backup/restore JSON, reset
2622  EVENT BINDING
~2765 INIT
2777  SEED DATA             — dữ liệu mẫu import từ file Excel gốc
```

## 7. Giới hạn kỹ thuật đã biết

- Không gửi email thật được (đã giải thích ở mục 5) — chỉ tạo bản nháp `.eml`.
- Cần internet để đồng bộ qua Cloudflare; nếu mất mạng app vẫn dùng được ở chế độ
  cục bộ (`localStorage`), tự đồng bộ lại khi có mạng trở lại (mỗi 25s hoặc khi bấm Lưu).
- Đổi mật khẩu Leader / đăng nhập không phải cơ chế bảo mật thật (xem mục 3).
- So khớp Change Owner/Relevant People theo tên chuỗi (không có ID định danh) — nếu 2 người
  trùng tên/tên viết quá khác nhau có thể match sai; chấp nhận được với quy mô nhóm hiện tại.
- Chưa test trên iPad/điện thoại (thiết bị mục tiêu đã chọn ban đầu là PC/Laptop).

## 8. Việc còn dang dở / đề xuất tiếp theo

- ⏳ **Tab "Hướng dẫn sử dụng"** (đặt sau tab Action Plan, ưu tiên nội dung hướng dẫn cho
  Leader) — đã được yêu cầu nhưng **bị ngắt giữa chừng, CHƯA làm**. Cần làm tiếp: thêm
  nav-item mới, 1 view tĩnh gồm các bước cơ bản (đăng nhập, tạo MoC, xin duyệt, theo dõi
  Action, gửi email báo cáo, điểm danh...), ưu tiên văn phong ngắn gọn dễ hiểu cho Leader
  (không phải Admin).
- Có thể cân nhắc thêm: phân quyền tương tự cho Action Plan (hiện Leader sửa được mọi Action,
  chưa giới hạn theo PIC như đã làm với MoC).

## 9. Kiểm thử nhanh sau khi sửa code

1. Mở file bằng Chrome/Edge, kiểm tra Console không có lỗi đỏ.
2. Đăng nhập thử cả 2 vai trò (Admin/`QAILD`, và 1 Leader bất kỳ/mật khẩu = tên) — kiểm tra
   nút Sửa/Xoá hiện đúng theo quyền.
3. Tạo 1 MoC mới → kiểm tra mã tự gợi ý đúng, lưu được, hiện trong Master List.
4. Vào Master List → bấm "Gửi Email báo cáo" → kiểm tra file `.eml` tải về mở được, biểu đồ
   không bị lệch/tràn.
5. Vào tab Cài đặt (đăng nhập Admin) → thử Xuất JSON rồi Nhập lại, kiểm tra dữ liệu còn nguyên.
6. Vào tab Cài đặt → nhập Worker URL + API key thật → bấm Kết nối → kiểm tra chấm tròn
   trạng thái chuyển xanh, mở app ở máy/trình duyệt khác cũng thấy cùng dữ liệu.

## 10. Deploy: HTML trên GitHub Pages, dữ liệu trên Cloudflare

### 10.0. File nào push lên GitHub, file nào không

Repo GitHub Pages là **công khai** (trừ khi trả phí GitHub Pro/Team cho repo private), nên
chỉ push những gì cần cho trang web + mã nguồn không nhạy cảm:

| Push lên GitHub | Không push (đã có trong `.gitignore`) |
|---|---|
| `index.html` — trang chính | `2026_MoC Master List - Simplify.xlsx` — dữ liệu MoC thật |
| `cloudflare/worker.js`, `cloudflare/wrangler.toml` — mã nguồn Worker (không chạy trên GitHub, chỉ lưu để version control) | `MoC_Tom_tat_kien_thuc_co_ban.txt` — tài liệu nội bộ |
| `HANDOFF.md`, `.gitignore` | `moc_data.json` — file rỗng, kiến trúc cũ không dùng nữa |
| | `.claude/` — cấu hình riêng để chạy thử local |

⚠️ **Lưu ý quan trọng:** bản gốc `index.html` từng có sẵn dữ liệu mẫu thật (25 MoC + 40
Action, tên người thật, công thức sản xuất...) nhúng cứng trong biến `SEED_DATA`. Dữ liệu
này **đã được xoá sạch** (thay bằng mảng rỗng) trước khi đưa lên GitHub — nếu sau này cần
seed lại dữ liệu thật để test, dùng nút **Nhập JSON** ở tab Cài đặt với 1 bản sao lưu, chạy
trên máy local, **đừng đưa dữ liệu thật trở lại vào code rồi commit**.

### 10.1. Deploy Cloudflare Worker + KV (làm trước)

```bash
cd cloudflare
npx wrangler login                        # mở trình duyệt để đăng nhập Cloudflare
npx wrangler kv namespace create MOC_KV   # copy "id" trả về, dán vào wrangler.toml
```
Sửa [`cloudflare/wrangler.toml`](cloudflare/wrangler.toml):
- `id` của `[[kv_namespaces]]` = id vừa tạo ở trên.
- `ALLOWED_ORIGIN` = URL GitHub Pages sẽ dùng (ví dụ `https://<username>.github.io`), để
  Worker chỉ chấp nhận request từ đúng trang này (CORS).

```bash
npx wrangler secret put API_KEY           # nhập một chuỗi bí mật tự chọn — đây là "mật khẩu"
                                           # để đọc/ghi dữ liệu, KHÔNG commit chuỗi này vào git
npx wrangler deploy                       # in ra URL dạng https://moc-data-api.xxx.workers.dev
```
Giữ lại API key và URL Worker vừa deploy — sẽ nhập vào tab **Dữ liệu & Cài đặt** của app.

### 10.2. Deploy HTML lên GitHub Pages

```bash
git init
git add index.html HANDOFF.md cloudflare .gitignore
git commit -m "Initial commit: MoC app + Cloudflare data API"
git branch -M main
git remote add origin <URL repo GitHub của bạn>
git push -u origin main
```
Sau đó vào GitHub → repo → **Settings → Pages** → Source: chọn branch `main`, thư mục `/`
(root) → Save. GitHub sẽ cấp URL dạng `https://<username>.github.io/<repo>/` và mở thẳng
được `index.html` ở URL gốc (không cần gõ thêm tên file).

⚠️ Không commit `moc_data.json` (đã có trong `.gitignore`) và không commit API key ở bất kỳ
đâu trong repo — repo GitHub Pages là **công khai** trừ khi dùng GitHub Pages private
(cần gói trả phí/GitHub Enterprise).

### 10.3. Kết nối app với dữ liệu

Mở trang đã deploy → đăng nhập Admin → tab **Dữ liệu & Cài đặt** → nhập Worker URL + API
key từ bước 10.1 → bấm **Kết nối**. Chỉ cần làm 1 lần cho mỗi trình duyệt/máy — sau đó
lưu trong `localStorage`, tự đồng bộ mỗi khi mở lại trang.

### 10.4. Cập nhật sau này

- Sửa `index.html` → `git add` → `git commit` → `git push` → GitHub Pages tự build lại sau
  ~1 phút.
- Sửa `cloudflare/worker.js` → chạy lại `npx wrangler deploy` trong thư mục `cloudflare/`.
