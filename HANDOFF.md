# HANDOFF — MoC Management App

Tài liệu bàn giao cho app quản lý MoC (Management of Change) nội bộ nhà máy ILD Coffee.
Cập nhật lần cuối: 2026-10-08. Viết để người/AI khác tiếp tục sửa code **mà không cần đọc lại
lịch sử hội thoại** — quyết định quan trọng và lý do đều ghi ở đây.

## 0. Trạng thái ngay lúc này

- **Thư mục làm việc chuẩn:** `C:\Users\BinhDang\Documents\GitHub\MoC` (clone của
  `https://github.com/ngocthanhthien/MoC`, nhánh `main`). Thư mục cũ `C:\Apps\M - MOC - New`
  là bản làm việc đời đầu, **đã lỗi thời** (index.html cũ, HANDOFF cũ) — đừng dùng làm nguồn.
- **Đã deploy cả hai phía ngày 2026-10-08** (Worker version `093675ed`, frontend qua GitHub
  Pages): sửa lỗi 403 tombstone (mục 2) + đăng nhập Tên đăng nhập/Mật khẩu và tab Quản lý người
  dùng mới (mục 3). Worker và frontend của đợt này **phải đi cùng nhau** — frontend gửi
  `{loginId, password}`, không tương thích với Worker trước đó; đừng rollback riêng một phía.
- **Worker production:** `https://moc-data-api.dangthanhbinh53.workers.dev` (tài khoản
  Cloudflare của người dùng, KV `MOC_KV` id nằm trong `cloudflare/wrangler.toml`).
- **Frontend production:** GitHub Pages của repo trên (origin được phép CORS:
  `https://ngocthanhthien.github.io`). `CONFIG.workerUrl` trong `index.html` đã trỏ đúng Worker.
- **Quy tắc làm việc với người dùng:** chỉ commit/push/deploy khi được yêu cầu rõ; repo GitHub
  là **công khai** — tuyệt đối không đưa dữ liệu MoC thật, secret `ADMIN_USER/ADMIN_PASS` hay
  file Excel nguồn vào repo (xem `.gitignore`, mục 9.0).
- Không có bộ test tự động lưu trong repo — xem mục 8 để tự dựng khi cần.

## 1. App là gì

Ứng dụng web **1 file HTML duy nhất** ([`index.html`](index.html), CSS+JS inline, không build,
không framework, không CDN) host trên GitHub Pages; dữ liệu đồng bộ qua **Cloudflare Worker +
KV** ([`cloudflare/worker.js`](cloudflare/worker.js)). UI tiếng Việt, thuật ngữ quen thuộc giữ
tiếng Anh. Dữ liệu thật chỉ nằm trên Cloudflare KV (source `SEED_DATA` cố tình để rỗng).

Giao diện hiện tại: **thương hiệu "ILD Crafted"** (nền kem, nâu espresso, logo ILD nhúng
base64) + **thanh tab ngang** (không còn sidebar dọc) — xem mục 4.

## 2. Dữ liệu & đồng bộ

- KV key `moc_data` gồm 5 collection: `mocList`, `actionPlan`, `agenda`, `attendant`, và
  **`people`** (danh sách Change Owner/PIC cấu hình ở tab Cài đặt: `{id, kind:'owner'|'pic', name, updatedAt}`).
  Danh mục tài khoản (`moc_users`) tách riêng — mục 3.
- Cache cục bộ: `localStorage` key `moc_app_cache_v1`. Token phiên: `moc_app_token_v1`.
  Theme: `ild-crafted-appearance-v1` (mục 5). Cỡ chữ trình chiếu lưu riêng từng máy.
- Merge theo `updatedAt` (union theo `id`, bản mới hơn thắng) ở cả client (`Storage.mergeData`)
  và Worker (`mergeData`). App tự `GET /data` mỗi 25 giây.
- **Xoá = tombstone** `{id, deleted:true, updatedAt}` (vì union-merge sẽ làm bản ghi "sống lại"
  nếu chỉ bỏ id khỏi payload). `queueDelete()` + `buildOutgoingPayload()` tạo tombstone;
  `normalizeData()` lọc sạch chúng nên phần còn lại của app không biết tombstone tồn tại.
- **Thêm collection mới phải sửa đủ các chỗ:** `Storage.mergeData`, `state.data`,
  `normalizeData`, `buildOutgoingPayload`, `saveData` (giữ lại local nếu Worker cũ không trả
  về key đó — đã làm cho `people`), `handleResetSeed`, và phía Worker: `emptyData`,
  `mergeData`, danh sách trong `handleDataPut`, luật ghi trong `assertWriteAllowed`.
- **Tombstone không bao giờ được client gửi lại** (đã bị `normalizeData()` lọc), nên
  `assertWriteAllowed()` phải bỏ qua bản ghi `deleted:true` đang lưu khi dò "id bị thiếu trong
  payload". Thiếu bước này thì sau lần xoá đầu tiên của Admin, mọi lần lưu của User đều bị 403
  `delete_requires_admin` (lỗi thật đã gặp, sửa 2026-10-08).
- Mất mạng: app dùng cache cục bộ, có Xuất/Nhập JSON thủ công ở tab Cài đặt.

## 3. Đăng nhập & phân quyền

Đăng nhập **bắt buộc** (body có class `auth-locked` cho tới khi xác thực xong). Mô hình làm
theo app CloseCAPGMP: **một form duy nhất** Tên đăng nhập (hoặc email) + Mật khẩu cho mọi tài
khoản; vai trò do Worker quyết định theo danh bạ.

| Vai trò | Quyền |
|---|---|
| **Admin** | Toàn quyền: sửa/xoá mọi thứ, tab Người dùng, tab Cài đặt. Có thể có **nhiều** Admin |
| **User** | Xem tất cả, tạo mới mọi loại; **chỉ sửa MoC nếu là Change Owner hoặc có tên trong Người liên quan**; không xoá, không vào Người dùng/Cài đặt |

- **Danh bạ tài khoản** ở KV `moc_users` (object theo `id`):
  `{id, name, loginId, function, role:'admin'|'user', enabled, passwordHash, passwordSalt,
  passwordIterations, createdAt, updatedAt}`. Mật khẩu do Admin đặt, chỉ lưu băm
  **PBKDF2-SHA256 có salt, 100.000 vòng** (mức tối đa Web Crypto của Workers cho phép) — không
  đọc lại được, chỉ đặt lại. `loginId` lưu chữ thường: username (`[a-z0-9._-]`, tối đa 32 ký tự)
  hoặc email; **không đổi được sau khi tạo**. `name` phải duy nhất (so khớp bỏ dấu) vì quyền sửa
  MoC xét theo tên.
- **Admin "bootstrap"** = secret `ADMIN_USER`/`ADMIN_PASS` ở Worker (không có trong code/KV,
  không hiện trong danh bạ, `id` phiên là `'admin'`). Dùng để tạo các tài khoản đầu tiên và là
  đường cứu hộ khi mất hết Admin trong danh bạ. Đổi mật khẩu = `npx wrangler secret put ADMIN_PASS`.
  Không tạo được tài khoản danh bạ trùng `loginId` với `ADMIN_USER`.
- **Di trú tài khoản cũ (Tên + Mã NV 6 số):** `migrateLegacyUsers()` chạy trong `loadUsers()` —
  bản ghi chưa có `loginId` được gán username = tên bỏ dấu viết liền (trùng thì thêm số: `…2`),
  `role` → `'user'`. Mật khẩu **vẫn là Mã NV cũ** (`checkPassword()` so SHA-256 với
  `employeeCodeHash`), lần đăng nhập đúng đầu tiên tự băm lại sang PBKDF2 và xoá `employeeCodeHash`.
  Tab Người dùng ghi chú "Mật khẩu = Mã NV cũ" (`legacyCode`) cho tới lúc đó. Endpoint
  `/auth/names` (danh sách tên trước khi đăng nhập) đã bỏ.
- **Phiên:** token ngẫu nhiên ở KV `session:<token>` (TTL 12h), gửi bằng `Authorization: Bearer`.
  Mỗi request Worker đọc lại danh bạ: tài khoản bị vô hiệu hoá/xoá → 401 ngay; đổi vai trò/tên có
  hiệu lực ở request kế tiếp. (App tham chiếu dùng JWT 30 ngày; ở đây giữ 12h vì hay dùng máy chung.)
- **Chốt chặn quản lý tài khoản (Worker):** không tự vô hiệu hoá chính mình; không tự hạ quyền
  nếu là Admin đang hoạt động duy nhất *và* không có Admin bootstrap. Lỗi trả về dạng mã
  (`name_taken`, `login_taken`, `login_invalid`, `password_too_short`, `cannot_disable_self`,
  `last_admin`, `account_disabled`…) — frontend dịch qua `USER_ERROR_VI`.
- **Phân quyền kiểm tra 2 lớp:** frontend (`canEdit/canDelete/canEditMoc...`) chỉ để ẩn/hiện
  nút; **lớp bảo mật thật là `assertWriteAllowed()` trong Worker** (so với dữ liệu đang lưu
  trên server, không tin client): tạo mới → ai cũng được; sửa MoC → Admin hoặc owner/relevant
  theo **bản ghi trên server**; sửa Action/Agenda/Attendant → ai đã đăng nhập; xoá → chỉ Admin.
  Vi phạm → 403, frontend tự đồng bộ lại.
- **`people`:** chỉ Admin được đổi. Với non-admin, Worker **bỏ qua** (không báo lỗi) `people`
  trong payload để User có tab hơi cũ vẫn lưu được MoC của mình.
- So khớp tên (owner/relevant) bỏ dấu, không phân biệt hoa thường (`normalizeNameForMatch`
  ở frontend, `normalizeName` ở Worker — giữ 2 bản **đồng bộ**).

## 4. Bản đồ tính năng

Thanh điều hướng **ngang** trên cùng (sticky) gồm logo ILD, các tab, ghi chú QA.P.035; dưới nó
là topbar (tiêu đề, cỡ chữ A−/A+/Đậm, trạng thái sync, nút Lưu, nút **Giao diện**, tài khoản).
Cấu trúc DOM vẫn là `#app > #sidebar + #main` (id `#sidebar` giữ nguyên dù giờ là thanh ngang —
chỉ CSS đổi; `--header-h` = chiều cao thanh tab, dùng làm `top` sticky của `#topbar`).
Thêm tab mới: thêm `.nav-item[data-view=x]`, `<section class="view" id="view-x">`, và khoá
`x` trong `VIEW_TITLES`; click handler `.nav-item` là generic.

- **Dashboard** — KPI (Tổng, Đang xử lý, Hoàn thành, Đã huỷ, **MoC trễ hạn (SLA)**, Action quá
  hạn), donut trạng thái, bar theo Dept/Nature, card "Cần chú ý".
- **Master List** — CRUD MoC (form 6 bước), mặc định ẩn Done/Cancel, gợi ý mã `MoC-<Dept>.<Năm>.<STT>`,
  sort cột + filter nhiều lựa chọn (mục 6), cột **Mức độ** (Classification), **dòng mở rộng ▸/▾**
  hiện nhanh Action gắn với MoC (khớp `action.mocCode === moc.mocNo`; trạng thái mở lưu ở
  `state.mlExpanded`), nút Xuất CSV, nút Gửi Email báo cáo (mục 7).
- **SLA / trạng thái tự động:** MoC có trường `classification` (`Minor|Major|Critical`).
  `mocEffectiveStatus(m)` trả `'Late'` nếu status gốc là `On progress` **và** số ngày từ
  `requestDate` > `CONFIG.classificationSlaDays[classification]` (mặc định 14/7/3). Tính **live**,
  **không ghi đè** `status` lưu trữ. Không có classification → không bao giờ tự thành Late.
  `Late` chỉ là trạng thái hiển thị/lọc (`CONFIG.mlStatusFilters`), **không** nằm trong
  `CONFIG.statuses` nên form không cho đặt tay. CSV xuất `status` gốc.
- **Action Plan** — theo dõi hành động, sort/filter, hạn tô màu theo tình trạng.
- **Agenda & Attendant** — agenda họp, bảng điểm danh W1–W52 (3 cột sticky, tự cuộn tới tuần hiện tại).
- **Hướng dẫn** — view tĩnh (`#view-guide`): menu neo, bảng quyền, callout, FAQ `<details>`.
  Nội dung viết tay trong HTML — **cập nhật khi đổi hành vi** (đặc biệt phân quyền, SLA).
- **Quản lý người dùng** (Admin) — bảng Họ tên / Đăng nhập / Bộ phận / Vai trò / Trạng thái; trên
  từng dòng: Nâng lên Admin ↔ Hạ xuống User, Vô hiệu hoá ↔ Kích hoạt (khoá nút với chính mình),
  ✎ sửa tên/bộ phận và **đặt lại mật khẩu**. Thanh công cụ: Tải lại, Xuất CSV (không có mật
  khẩu), Tải Template CSV, **Nhập từ CSV** tạo tài khoản hàng loạt (`parseCSV` tự nhận dấu
  phân cách `,` `;` tab; kiểm tra từng dòng bằng `userInputProblem` trước khi gửi; mỗi dòng một
  `POST /users`). Dùng CSV thay vì Excel như app tham chiếu vì app này không nhúng thư viện.
- **Dữ liệu & Cài đặt** (Admin) — trạng thái Cloud Sync, **Danh sách Change Owner & PIC**,
  backup/restore JSON, reset dữ liệu mẫu (giữ nguyên `people`).

### Danh sách Change Owner / PIC (tab Cài đặt)
- Hai danh sách (`kind` owner/pic). **Khi một danh sách có ≥1 tên**, các ô tương ứng thành
  `<select>` chỉ-chọn: Change Owner (form MoC ← owner), Người liên quan (readonly, chọn từ owner∪pic,
  có "Xoá hết"), PIC & Phối hợp (form Action ← pic). **Danh sách rỗng → vẫn gõ tự do** như cũ.
- Giá trị cũ ngoài danh sách vẫn hiện nguyên với nhãn "(giá trị cũ)" (qua `selectOptions`), không mất dữ liệu.
- Từ chối tên trùng (không phân biệt hoa thường) và tên chứa `,` `/` (vì `relevantPeople` tách bằng các ký tự này).
- Nút "Nhập từ tên đã dùng trong dữ liệu" seed danh sách từ MoC/Action hiện có.
- Hàm: `peopleNames/ownerListOrNull/picListOrNull/relevantListOrNull`, `renderPeopleSettings`,
  `addPerson`, `removePerson`, `importKnownPeopleToLists`.

## 5. Thương hiệu ILD Crafted & module Theme

- Nguồn yêu cầu gốc: file `C:\Apps\Decoration\Prompt nhận diện.txt` (ngoài repo). Ràng buộc chính:
  giữ logo ILD **nguyên bản, luôn trên nền trắng** (kể cả theme tối), không đảo màu/lọc; màu
  trạng thái (xám/xanh dương/vàng/xanh lá/đỏ) giữ **ý nghĩa**; focus bàn phím luôn `#2563EB`;
  không thêm CDN/font ngoài; in ấn không bao giờ nền tối.
- **Token màu** ở `:root` (tên `--blue*` giữ nguyên nhưng nay mang vai trò "primary espresso";
  `--blue-fg` là màu chữ trên nền primary — đảo sang tối ở dark theme; `--focus/--focus-ring`
  riêng cho focus; `--ild-red` chỉ làm điểm nhấn nhỏ như vạch tab đang chọn). Palette: nền
  `#F7F0E6`, bề mặt `#FBF4E8`/`#FFFFFF`, chữ `#2A2018`, primary `#382E28`.
- **Theme** = tính năng thêm duy nhất của đợt đó: nút "Giao diện" mở dialog (4 preset: Crafted
  tiêu chuẩn/đậm/tối/Tương phản cao + Sáng/Tối/Theo hệ thống, Tương phản Tiêu chuẩn/Cao, Độ đậm
  Nhẹ/Tiêu chuẩn/Đậm, nút khôi phục mặc định). Lưu `localStorage['ild-crafted-appearance-v1']`
  (`{appearance, contrast, emphasis}`, validate khi đọc, lỗi storage không làm app hỏng).
- Cấu trúc: (1) script nhỏ đầu `<head>` áp theme sớm chống chớp màu; (2) khối CSS
  `ILD THEME — APPEARANCE OVERRIDES` (ghi đè token qua `:root[data-ild-appearance|contrast|emphasis]`);
  (3) markup dialog `#ild-theme-overlay` + IIFE JS riêng ở cuối `<body>` (không đụng handler
  nghiệp vụ; Escape dùng `stopPropagation` để không đóng nhầm modal nghiệp vụ; trả focus về nút
  mở). Thuộc tính/ID/class mới đều tiền tố `ild-theme-` / `data-ild-`.
- Muốn đổi màu: sửa **token**, đừng thay màu cứng rải rác. Màu cứng còn lại là có chủ đích
  (logo box `#fff`, màu semantic status).
- In ấn: `@media print` ép token sáng và ẩn nút/dialog Theme (chưa test bằng print preview thật).
- Logo là ảnh base64 trên **một dòng rất dài** trong `.brand` — dùng `Grep`/`sed`, đừng `Read`
  vùng đó (tool đọc file sẽ báo vượt giới hạn token).

## 6. Sort, filter, ngày, Việt hoá popup

- **Sort:** `<th data-sort="field">` click để sort (▲/▼); trạng thái `state.mlSort/apSort`;
  `sortRows()` so chuỗi bằng `localeCompare('vi')` (ISO date so chuỗi vẫn đúng). Sort `status`
  theo `status` lưu, không theo `Late`.
- **Filter nhiều lựa chọn:** component `MultiSelect` tự viết (không dùng `<select multiple>`);
  rỗng = tất cả; trạng thái chỉ trong bộ nhớ (mất khi tải lại — có chủ đích). Không hỗ trợ map
  nhãn hiển thị (hiện nguyên giá trị).
- **Ngày:** lưu **luôn ISO `yyyy-mm-dd`**; hiển thị `Utils.formatDateVN()`. Mọi `<input type="date">`
  phải qua `wireDateField()/wireAllDateFields(rootEl)` sau khi render (input native ẩn giữ id gốc +
  ô `readonly` hiển thị dd/mm/yyyy, click gọi `showPicker()`), vì định dạng `type="date"` phụ thuộc
  locale trình duyệt. Thêm trường ngày mới: dùng `type="date"` + gọi `wireAllDateFields`.
- **Việt hoá popup:** chỉ nhãn trong modal MoC/Action. Dropdown enum dùng
  `selectOptions(values, current, labels)` — **value giữ tiếng Anh gốc**, chỉ nhãn dịch
  (`STATUS_LABEL_VI/TYPE_LABEL_VI/NATURE_LABEL_VI/CLASSIFICATION_LABEL_VI`). Không đổi value
  vì filter/badge/CSV/dashboard so sánh theo chuỗi gốc. Giữ tiếng Anh: Change Owner, Area Owner,
  PIC, SHE, MoC, Action Plan.

## 7. Gửi Email báo cáo

Trang tĩnh không gửi mail được → nút tạo file **`.eml`** (có `X-Unsent: 1`, Outlook mở ở chế độ
soạn) chứa KPI, biểu đồ PNG vẽ bằng Canvas (`drawEmailChart`), bảng MoC/Action theo bộ lọc
hiện tại, điểm danh tuần hiện tại. Nút phụ: sao chép nội dung, mở `mailto:` (chỉ text).

## 8. Kiến trúc mã & cách kiểm thử

Map `index.html` (~4265 dòng; luôn `grep -n` lại tên section thay vì tin số dòng):
`ILD THEME` (CSS) → `CONFIG` → `UTILS` → `DATE FIELDS` → `PRESENTATION MODE` → `API` →
`STORAGE` → `STATE` → `AUTH / PERMISSIONS` → `SYNC STATUS UI` → `SAVE / LOAD PIPELINE` →
`INIT STORAGE` → `NAVIGATION` → `FILTER OPTIONS` → `TABLE SORT` → `DASHBOARD RENDER` →
`MASTER LIST RENDER` → `PEOPLE SUGGESTIONS` (+ danh sách Change Owner/PIC) → `MOC FORM MODAL` →
`ACTION PLAN` → `ATTENDANT` → `EXPORT CSV` → `EMAIL REPORT` → `SETTINGS` → `USER MANAGEMENT` →
`EVENT BINDING` → `INIT` → `SEED DATA` (rỗng); sau `</script>` chính còn dialog Theme + script Theme.

`cloudflare/worker.js`: `handleLogin/Me/Logout` (`/auth/*`), `handleUsersList/Create/Update`
(`GET/POST /users`, `PUT /users/:id` nhận `{name, function, enabled, role, password}` — admin),
`handleDataGet/Put` (`/data`), `assertWriteAllowed()`; tài khoản: `migrateLegacyUsers`,
`checkPassword`, `setPassword`, `loginIdError`, `hasOtherActiveAdmin`.

**Kiểm tra nhanh sau khi sửa frontend** (quy trình đã dùng xuyên suốt):
1. Cú pháp: tách các khối `<script>...</script>` rồi `new Function(code)` bằng Node.
2. Đối chiếu mọi `getElementById('...')` với `id="..."` thực có trong HTML (phải không thiếu).
3. Chạy tĩnh: `python -m http.server` trong thư mục repo, mở `index.html`. Vì login bắt buộc và
   CORS chỉ cho origin GitHub Pages, khi test cục bộ hãy mở khoá bằng JS
   (`document.body.classList.remove('auth-locked'); document.getElementById('modal-login').style.display='none'`),
   gán `state.currentUser`, bơm `state.data.*`, và stub `Api.putData/listUsers/updateUser`
   — **không** gọi Worker thật bằng dữ liệu/tài khoản thật khi chỉ test giao diện.

**Kiểm tra Worker** (không cần deploy): viết script Node `import worker from './cloudflare/worker.js'`,
`env.MOC_KV` = object giả `get(key,'json')/put/delete` dùng `Map`, tạo sẵn `session:<token>` và
`moc_users`, rồi `worker.fetch(new Request('http://x/data',{method:'PUT',headers:{Authorization:'Bearer <token>'},body}), env)`.
Các ca nên kiểm: admin ghi `people` OK; leader ghi `people` bị bỏ qua (200 nhưng không đổi);
client cũ không gửi `people` không bị coi là xoá; leader sửa MoC không phải của mình → 403;
leader xoá → 403; **User lưu khi server đang có tombstone → 200**; tài khoản cũ đăng nhập bằng
username sinh tự động + Mã NV; tạo trùng tên/trùng `loginId` → 409; tự vô hiệu hoá → 400;
vô hiệu hoá xong phiên cũ → 401, đăng nhập lại → 403 `account_disabled`.

**Chạy thử cả app cục bộ không đụng production:** viết server Node nhỏ phục vụ `index.html`
(thay chuỗi `workerUrl` thành `'/api'` lúc trả về) và chuyển `/api/*` vào `worker.fetch` với KV
giả — đăng nhập, tab Người dùng, lưu dữ liệu đều chạy thật trên trình duyệt. Đã dùng cách này
để kiểm thử đợt 2026-10-08.

## 9. Deploy

### 9.0. Cái gì được push lên GitHub (repo công khai)
Push: `index.html`, `HANDOFF.md`, `.gitignore`, `cloudflare/worker.js`, `cloudflare/wrangler.toml`.
**Không push** (đã trong `.gitignore`): file Excel dữ liệu thật, tài liệu nội bộ, `moc_data.json`,
`.claude/`, `node_modules/`, `.wrangler/`, `cloudflare/.dev.vars`. **Không bao giờ** đưa dữ liệu
thật quay lại `SEED_DATA`, cũng không commit `ADMIN_USER/ADMIN_PASS`.
(Lịch sử: từng lộ dữ liệu thật lên repo công khai và đã xoá sạch bằng orphan branch + force-push —
đừng lặp lại.)

### 9.1. Worker
```bash
cd cloudflare
npx wrangler login                      # nếu chưa đăng nhập
npx wrangler deploy                     # dùng wrangler.toml trong thư mục này
# lần đầu / đổi mật khẩu Admin:
npx wrangler secret put ADMIN_USER
npx wrangler secret put ADMIN_PASS
```
`wrangler.toml` đã chứa KV id thật và `ALLOWED_ORIGIN = "https://ngocthanhthien.github.io"`
(chỉ gồm origin, **không** kèm đường dẫn `/MoC/` — kèm sẽ làm CORS sai). `wrangler deploy` đọc file
local nên Worker có thể **mới hơn commit git** — đừng deploy đè bản cũ.
Sau deploy: `curl -i https://moc-data-api.dangthanhbinh53.workers.dev/data` phải trả 401 JSON.

### 9.2. Frontend (GitHub Pages)
`git add` → `git commit` → `git push origin main`; Pages tự build lại sau ~1 phút (Settings →
Pages: branch `main`, thư mục `/`). Người dùng cần Ctrl+F5 để lấy bản mới.

### 9.3. Lần đầu
Đăng nhập bằng Admin bootstrap (`ADMIN_USER`/`ADMIN_PASS`) → tab **Người dùng** tạo tài khoản
(tự đặt Tên đăng nhập + Mật khẩu ban đầu, hoặc Nhập từ CSV), nên tạo luôn một Admin trong danh bạ
cho từng người quản trị → tab **Cài đặt** thiết lập danh sách Change Owner/PIC.
**Sau khi deploy đợt đăng nhập mới:** mở tab Người dùng xem Tên đăng nhập đã sinh cho các tài
khoản cũ và báo lại cho từng người (mật khẩu của họ vẫn là Mã NV cũ).

## 10. Giới hạn đã biết & việc có thể làm tiếp

- Không gửi email thật được (chỉ `.eml`); cần internet để đăng nhập/đồng bộ; phiên hết hạn 12h;
  người dùng chưa tự đổi được mật khẩu (chỉ Admin đặt lại); không giới hạn số lần đăng nhập
  sai; không xoá hẳn được tài khoản (chỉ vô hiệu hoá); chưa test trên iPad/điện thoại ở mức đầy đủ (thanh tab ngang có cuộn ngang; nút
  Giao diện bị ẩn ở màn hình ≤480px vì topbar hết chỗ — truy cập được từ ≥481px).
- Sửa MoC xét quyền theo bản ghi **trên server** → hai người sửa gần đồng thời có thể bị 403 và
  bị đồng bộ lại (mất thao tác dang dở); so khớp owner theo tên chuỗi nên trùng/khác tên có thể sai.
- SLA chỉ áp cho MoC (không cho Action — Action đã có `dueDate` riêng). Số ngày SLA nằm cứng trong
  `CONFIG.classificationSlaDays` (chưa có UI chỉnh).
- Ý tưởng chưa làm: phân quyền Action theo PIC; đính kèm bằng chứng qua File System Access API
  (như app RCA, chỉ Chrome/Edge desktop — cần cân nhắc kiến trúc); `Late` trong CSV/email;
  UI chỉnh SLA; sort theo trạng thái hiệu lực.
- Chưa kiểm chứng bằng print preview thật và chưa chạy lại CSV/email sau khi đổi giao diện. App
  **không có** nút In/PDF/Excel (chỉ CSV, `.eml`, JSON backup) — đừng ghi trong Hướng dẫn rằng có.
