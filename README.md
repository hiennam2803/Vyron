# VYRON — Phase 1a

Every video. Your language.

Phase 1a chỉ làm 3 việc: lấy phụ đề có timestamp từ YouTube, theo dõi trạng thái phát video, và hiển thị để kiểm tra.
**Chưa có dịch máy, chưa có TTS, chưa có đồng bộ giọng đọc.**

## Cài đặt và chạy

Yêu cầu: Node.js 20.19+ (khuyến nghị 22), Chrome ≥ 111 (xem `chrome://version`).

```bash
npm install
npm run build        # tạo thư mục dist/
npm run dev          # build lại tự động khi sửa code (sau đó bấm reload extension)
npm test             # unit test cho logic thuần (cần Node 22.6+)
npm run typecheck
```

Nạp vào Chrome: `chrome://extensions` → bật **Developer mode** → **Load unpacked** → chọn thư mục `dist/`.
Sau mỗi lần build: bấm nút reload của extension **và tải lại (F5) tab YouTube**.

## Cấu trúc

```
manifest.json                 MV3, không xin permission nào; chỉ content script cho www.youtube.com
scripts/build.mjs             Build Vite, mỗi entry -> 1 file IIFE trong dist/
src/page/page-bridge.ts       Chạy ở MAIN world: đọc player response, tải nội dung track
src/content/index.ts          Bộ điều phối: điều hướng SPA, tải phụ đề, theo dõi phát, trả state cho popup
src/content/bridge-client.ts  Gọi page-bridge qua postMessage (có timeout)
src/content/youtube-adapter.ts  Mọi giả định về DOM YouTube (tìm <video>, phát hiện quảng cáo)
src/content/transcript-manager.ts  parseJson3, findSegmentIndex, pickDefaultTrackIndex (logic thuần, có test)
src/content/playback-monitor.ts    Sự kiện media + tick 100ms khi đang phát
src/content/debug-hud.ts      Bảng debug nhỏ trên trang (tạm thời)
src/popup/*                   Popup kiểm tra: trạng thái, chọn track, danh sách đoạn, bấm để tua
src/shared/*                  Kiểu dữ liệu, giao thức message, tách video ID từ URL
tests/                        Unit test (node:test)
```

## Phương pháp lấy phụ đề (và trạng thái kiểm chứng)

1. Trong MAIN world, đọc `#movie_player.getPlayerResponse()` → `captions.playerCaptionsTracklistRenderer.captionTracks`.
   Có đối chiếu `videoDetails.videoId` với URL để không lấy nhầm dữ liệu của video trước khi chuyển SPA.
2. Tải `baseUrl` với `fmt=json3` (cùng origin, kèm cookie).
3. Nếu bước 2 thất bại (ví dụ HTTP 200 nhưng rỗng), thử lại bằng URL `timedtext` mà **chính player YouTube** đã gọi
   (ghi nhận bằng `PerformanceObserver`, chỉ khi URL có `pot`). Cách này cần người dùng bật CC một lần.
4. Nếu cả hai thất bại: hiển thị mã lỗi cụ thể + hướng dẫn. **Không tạo dữ liệu giả.**

> **Chưa được kiểm chứng trên YouTube thật.** Các bước 2–3 phụ thuộc hành vi hiện tại của YouTube (token `pot`, định dạng json3),
> thứ có thể thay đổi. Kết quả thực tế của bạn quyết định có cần phương án 4 (đọc panel Transcript) hay không.

Lưu ý quảng cáo: khi đang chiếu quảng cáo, phần tử `<video>` phát quảng cáo nên `currentTime` không thuộc video chính.
VYRON phát hiện `.ad-showing`, không đối chiếu phụ đề trong lúc đó, và không can thiệp vào quảng cáo.

## Đã chạy thật trong môi trường phát triển

- [x] `node --test`: 11/11 test pass (parse json3, tìm đoạn khi tua, biên, chồng lấn, chọn track mặc định, tách video ID)
- [x] `tsc` typecheck: 0 lỗi (dùng stub tối thiểu cho `chrome.*` vì không có mạng để cài `@types/chrome`;
      bạn nên chạy lại `npm run typecheck` sau `npm install`)
- [ ] `npm install` và `npm run build` (Vite) — **chưa chạy**, môi trường phát triển không có mạng
- [ ] Nạp vào Chrome và mọi mục kiểm thử thủ công bên dưới — **chưa chạy**

## Checklist kiểm thử thủ công (đánh dấu khi bạn đã chạy thật)

Chuẩn bị: mở DevTools của tab YouTube (F12) để xem lỗi console; mở `chrome://version` và ghi lại phiên bản.

Phụ đề
- [ ] Video có phụ đề tiếng Anh thủ công → trạng thái "Đã lấy phụ đề", `qua baseUrl` hay `player-captured`?
- [ ] Video chỉ có phụ đề tự động (ASR) → số đoạn chồng lấn là bao nhiêu?
- [ ] Video nhiều track → đổi track trong popup, danh sách đoạn đổi theo
- [ ] Video không có phụ đề → lỗi `NO_CAPTION_TRACKS`, thông báo rõ ràng
- [ ] Nếu gặp `EMPTY_RESPONSE`: bật CC trên player → bấm "Tải lại" → có lấy được không?
- [ ] Đối chiếu 3–5 đoạn ngẫu nhiên với phụ đề hiển thị trên player: timestamp có khớp?

Theo dõi phát (xem HUD góc dưới trái của trang và popup)
- [ ] Phát: `t` tăng đều, đoạn hiện tại đổi đúng lúc
- [ ] Pause / resume: log ghi `pause` / `play`, trạng thái đúng
- [ ] Tua tiến, tua lùi (phím mũi tên, click thanh tiến trình): ghi `seeking` → `seeked`, đoạn hiện tại đúng
- [ ] Bấm một đoạn trong popup → video nhảy đến đúng đoạn đó
- [ ] Đổi tốc độ 0.5x / 1.5x / 2x: log `ratechange`, HUD hiển thị tốc độ đúng
- [ ] Đổi video bằng click gợi ý (SPA): HUD chuyển sang video ID mới, đoạn cũ biến mất, phụ đề mới được nạp
- [ ] Đổi video khi phụ đề video trước chưa tải xong: không bao giờ hiện phụ đề của video cũ
- [ ] Video có quảng cáo đầu: HUD ghi `ad=true`, không có đoạn phụ đề nào bị đối chiếu trong lúc đó
- [ ] Quay về trang chủ YouTube: trạng thái "Chưa ở trang video"

## Giới hạn đã biết

- HUD nằm ngoài player nên **không hiện ở chế độ toàn màn hình**; kiểm thử tua/pause ở chế độ thường hoặc theater.
- Chỉ hỗ trợ `www.youtube.com` (chưa có `m.youtube.com`, `music.youtube.com`).
- Tick 100ms bị trình duyệt làm chậm khi tab ở nền; chấp nhận được ở Phase 1a.
- Popup không giữ trạng thái khi đóng (đọc lại từ content script mỗi lần mở).
- `@types/chrome` đang để `latest` vì chưa kiểm chứng phiên bản cụ thể; nên ghim phiên bản sau lần cài đầu.

## Phase 2 - Dịch bằng Chrome Translator API

Quyết định: dùng Translator API có sẵn của Chrome (en → vi), không đóng gói mô hình riêng.

Luồng: phụ đề đã lấy → kiểm tra `Translator.availability()` → (cần thì tải gói ngôn ngữ) → dịch cửa sổ 30 đoạn
phía trước vị trí đang phát, chia lô 6 câu → lưu cache → hiện bản dịch trong popup và bảng debug.

```
src/translation/translation-engine.ts  Hàng đợi, cửa sổ lookahead, cache, chống trùng, hủy (không phụ thuộc Chrome, có test)
src/content/translator-backend.ts      Backend: gọi Translator API qua page-bridge
src/page/page-bridge.ts                Translator API chạy ở MAIN world (cần user activation của trang để tải gói ngôn ngữ)
src/background/service-worker.ts       Nhận lệnh cache từ content script/popup
src/storage/cache.ts                   IndexedDB của extension; tối đa 20.000 mục, xóa mục cũ nhất khi đầy
src/content/cache-client.ts            Gọi service worker từ content script
```

Quy tắc đã cài và có test: không dịch trùng (cùng nội dung chỉ gọi một lần, kể cả giữa các video qua cache),
không sửa timestamp, hủy khi đổi video/track, kết quả đến muộn không ghi đè video mới,
đoạn lỗi thử lại tối đa 3 lần rồi bỏ (không lặp vô hạn), cache lỗi không làm hỏng việc dịch.
Phụ đề tự động (asr) chồng lấn đã được cắt endTime từ Phase 1a.

### Lần đầu cần tải gói ngôn ngữ
Nếu Chrome báo `downloadable`, bảng VYRON trên trang hiện nút **Tải gói ngôn ngữ tiếng Việt**. Phải bấm nút đó (không phải nút trong popup):
Chrome chỉ cho tải khi có thao tác bấm ngay trên chính trang YouTube.

### Chưa kiểm chứng (cần bạn chạy trên Chrome thật)
- Translator API gọi từ MAIN world của youtube.com có chạy không, tên trạng thái `availability` trên bản Chrome của bạn
- Cache IndexedDB trong service worker (chưa có test tự động vì Node không có IndexedDB)
- Chất lượng dịch các mảnh phụ đề tự động (mỗi đoạn được dịch riêng, chưa ghép thành câu)

## Checklist kiểm thử Phase 2 (đánh dấu khi bạn đã chạy thật)

Chuẩn bị: `npm run build`, reload extension, F5 tab YouTube, mở DevTools Console để xem lỗi.

Dịch cơ bản
- [ ] Video ngắn (< 5 phút), phụ đề tự động: popup hiện "Dịch: sẵn sàng", bản dịch xuất hiện dưới các đoạn sắp phát
- [ ] Lần đầu: nếu hiện nút "Tải gói ngôn ngữ tiếng Việt", bấm nút trên trang, thấy phần trăm tải, rồi chuyển sang sẵn sàng
- [ ] Video có phụ đề thủ công: dịch đúng, timestamp không đổi
- [ ] Video dài (> 30 phút): chỉ dịch cửa sổ phía trước (số "đã dịch X/Y" tăng dần theo lúc xem, không nhảy lên 100% ngay)
- [ ] Bản dịch của đoạn đang phát hiện trong bảng debug (dòng bắt đầu bằng →)

Tua và chuyển video
- [ ] Tua tiến xa: đoạn ở vị trí mới được dịch trong vài giây, không phải chờ dịch hết đoạn bị bỏ qua
- [ ] Tua lùi về đoạn đã dịch: có bản dịch ngay, "gọi bộ dịch" không tăng
- [ ] Đổi video khi đang dịch: bản dịch video cũ không xuất hiện ở video mới
- [ ] Mở lại video đã xem: bản dịch lấy từ cache gần như tức thì ("gọi bộ dịch" ≈ 0)
- [ ] Câu lặp lại nhiều lần trong video chỉ được gọi bộ dịch một lần

Lỗi và môi trường
- [ ] Tắt mạng (sau khi gói ngôn ngữ đã tải): vẫn dịch được đoạn mới; đoạn đã cache vẫn hiện
- [ ] Tắt mạng khi chưa có gói ngôn ngữ, rồi bấm tải: báo lỗi rõ ràng, bật mạng và "Thử lại" được
- [ ] Reload extension khi đang mở tab YouTube: bảng debug báo "extension vừa được tải lại, bấm F5"; sau F5 hoạt động bình thường, cache vẫn còn
- [ ] Nút "Xóa cache dịch" trong popup: số mục về 0
- [ ] Chrome không có Translator API (nếu có bản cũ để thử): thông báo rõ, không hiện "thành công" giả

Ghi lại cho mỗi lỗi: ảnh popup và bảng debug, phiên bản Chrome (chrome://version).

## Phase 3 (bản 0.4) - Giọng đọc tự đồng bộ

Popup chỉ còn: công tắc **Đọc bản dịch**, một dòng trạng thái, thanh **Âm lượng video khi đang đọc**, và mục **Nâng cao**
(chọn giọng khác, cho phép giọng qua mạng, bảng chẩn đoán, xóa cache). Không còn: đọc thử, chọn track phụ đề, tốc độ đọc,
chế độ đọc đầy đủ/đồng bộ, bỏ nhãn âm thanh (luôn bỏ). Track phụ đề được chọn tự động.

```
src/speech/pacing.ts          Đếm âm tiết, PaceModel (tự đo tốc độ đọc thật + độ trễ khởi động), planRate (chọn tốc độ)
src/speech/speech-driver.ts   Quyết định đọc gì, khi nào, nhanh bao nhiêu; 2 chế độ natural/catchup tự chuyển
src/speech/speech-engine.ts   Bọc speechSynthesis: một câu một lúc, KHÔNG tự cắt câu, báo thời gian thật về driver
src/speech/speakable.ts       Bỏ nhãn [âm nhạc], ♪, ">>"; câu ngắn bỏ dấu câu, câu dài giữ dấu (giữ dấu giữa số: 3.5, 1,000)
src/speech/ducking.ts         Hạ âm lượng video khi đọc, trả đúng mức cũ
src/content/status-pill.ts    Nhãn nhỏ trong khung player (hiện cả khi toàn màn hình), tự mờ; chứa nút "Tải về" gói ngôn ngữ
src/content/debug-hud.ts      Bảng chẩn đoán, mặc định ẩn
```

### Cách đồng bộ
1. **Không cắt câu đang đọc.** Bản cũ cắt câu hiện tại mỗi khi sang đoạn mới -> đứt chữ, mất chữ. Nay chỉ pause/tua/quảng cáo/tắt mới dừng giọng.
2. **Tốc độ tính cho từng câu**: số âm tiết ÷ (thời gian còn lại tới khi đoạn kế bắt đầu, theo giây thực, đã tính tốc độ phát của video và độ trễ khởi động).
   Không bao giờ chậm hơn 1.0x; thừa thời gian thì đọc tự nhiên rồi chờ. Tăng ngay khi cần, giảm từ từ (0.15 mỗi câu) để không giật.
3. **Tự đo giọng thật**: mỗi câu đọc xong, đo thời lượng thật để cập nhật tốc độ đọc của giọng đang dùng (đổi giọng thì đo lại).
   Đo độ trễ từ lúc gọi đến lúc có tiếng và gọi sớm đúng khoảng đó, để tiếng vang lên đúng lúc đoạn bắt đầu.
4. **Hai chế độ tự chuyển** (có độ trễ chuyển, không nhấp nháy):
   - `natural`: mỗi đoạn một câu, trần 1.6x.
   - `catchup`: khi trễ hơn ~1.5 giây hoặc dồn từ 3 đoạn, gộp các đoạn đến hạn (tối đa 3 đoạn / 34 từ) thành một câu liền mạch, trần 1.9x,
     và chỉ bỏ **nguyên** những đoạn đã kết thúc quá lâu (3 giây ở natural, 1.5 giây ở catchup). Hết trễ thì tự quay về natural.
5. **Dấu câu**: câu dài (hơn 5 từ) giữ nguyên dấu câu để giọng ngắt nghỉ bình thường; câu ngắn (tối đa 5 từ) bỏ dấu câu để đọc lướt liền mạch. Ngoặc, ngoặc kép, gạch ngang luôn bỏ. Dấu giữa chữ số được giữ để không đọc sai số.
6. **Âm lượng**: hạ video TRƯỚC khi giọng vang lên (bản cũ hạ khi đã bắt đầu đọc nên nuốt âm đầu), giữ hạ trong suốt chuỗi câu liền nhau
   (trả sau 0.6 giây yên lặng), mặc định còn 15%. Giới hạn: Web Speech API đặt `volume` tối đa 1.0, không khuếch đại thêm được;
   nếu vẫn nhỏ, kiểm tra âm lượng hệ điều hành / Volume Mixer của Chrome, hoặc thử giọng khác trong Nâng cao.

### Đã kiểm chứng trong môi trường phát triển
- [x] `node --test`: 86/86 pass, gồm mô phỏng đồng bộ (giọng giả có tốc độ và độ trễ khởi động thật) ở các tình huống: người nói bình thường,
      người nói nhanh + giọng chậm, video 1.5x, video 2x, giọng độ trễ cao. Kết quả mô phỏng: 0-1% đoạn bị bỏ, không lần cancel nào giữa chừng,
      độ lệch giữa lúc giọng vang lên và lúc đoạn bắt đầu: trung vị 0.03-0.3 giây, phân vị 90 dưới 1.3 giây. Đây là mô hình, không phải Chrome thật.
- [x] `tsc` sạch lỗi (dùng stub `chrome.*` vì không có mạng để cài `@types/chrome`)
- [x] Bundle được cả 4 entry; popup và nhãn trên video render đúng trong Chromium headless (với `chrome.*` giả)
- [ ] `npm run build` bằng Vite, nạp vào Chrome thật: **chưa chạy** (không có mạng)

### Checklist kiểm thử thủ công (Chrome thật)
- [ ] Video thoại nhanh: nghe có đứt/mất chữ không; mở Nâng cao → bảng chẩn đoán xem `đồng bộ:` (mode, rate, trễ, bỏ)
- [ ] Đổi tốc độ video 1.25x / 1.5x / 2x: giọng tự nhanh theo, vẫn nghe rõ chữ
- [ ] Pause: dừng ngay, âm lượng trả lại; resume: đọc lại câu dở từ đầu
- [ ] Tua nhiều lần liên tục: không đọc câu cũ, không đọc chồng
- [ ] Quảng cáo đầu video: không đọc trong lúc quảng cáo
- [ ] Âm lượng: so với bản cũ, giọng đọc có rõ hơn không ở mức video 15% và 5%
- [ ] Giữa các câu liền nhau, tiếng video có bị nhảy to nhỏ khó chịu không
- [ ] Nhãn trên video hiện ở chế độ toàn màn hình; nút "Tải về" gói ngôn ngữ hoạt động

Ghi lại nếu có lỗi: ảnh bảng chẩn đoán (dòng `giọng:` và `đồng bộ:`), tên giọng, phiên bản Chrome.

### Chưa làm
- Giọng đám mây (ví dụ giọng miền Nam): cần khóa API cá nhân và backend an toàn, không nhúng khóa vào extension.
- Giọng qua mạng của Chrome có thể giới hạn độ dài câu; chưa kiểm chứng trên máy bạn.

## Bản 0.5 - Gộp câu và logo

**Gộp mảnh phụ đề thành câu** (`src/content/sentence-merger.ts`). Phụ đề YouTube, nhất là phụ đề tự động, bị cắt theo màn hình
hoặc nhịp thở chứ không theo câu, nên trước đây mỗi mảnh được dịch và đọc riêng ("Chúng ta nên bắt" ... dừng ... "đầu từ đâu nhỉ?").
Từ bản này các mảnh liền nhau được nối thành câu trước khi dịch và đọc. Một mảnh được nối vào mảnh trước khi:

- mảnh trước chưa kết thúc bằng `. ! ?` (chữ viết tắt như `Dr.` không tính là hết câu),
- khoảng lặng giữa hai mảnh ≤ 0.8 giây (≤ 1.6 giây nếu mảnh trước kết thúc bằng từ nối như `the`, `and`, `và`, `của`),
- câu gộp không quá 24 từ và 9 giây (tối đa 34 từ / 13 giây nếu đang dở câu),
- không có nhãn âm thanh (`[Music]`, ♪) hoặc đổi người nói (`>>`) ở giữa.

Timestamp được giữ trung thực: câu gộp bắt đầu ở mảnh đầu, kết thúc ở mảnh cuối. Chỉnh các ngưỡng ở `DEFAULT_MERGE_OPTIONS`.

**Nghe rõ chữ hơn:** trần tốc độ giảm từ 1.6x/1.9x xuống 1.5x/1.75x (`src/speech/pacing.ts`).

**Logo:** thay `icons/logo.png` bằng logo của bạn (PNG vuông, tối thiểu 128x128), rồi `npm run build`.
Một file dùng cho cả biểu tượng thanh công cụ, trang quản lý extension và popup. Chrome extension không dùng `.ico`, hãy xuất sang PNG.

## Bản 0.6 - Đọc số và từ tiếng Anh

**Đọc số** (`src/speech/numbers.ts`): số, tiền, %, giờ, ngày, đơn vị được đổi thành chữ trước khi đọc.
`10.000 đô` -> "mười nghìn đô", `$2M` -> "hai triệu đô la", `50%` -> "năm mươi phần trăm", `10:30` -> "mười giờ ba mươi",
`2024` -> "hai nghìn không trăm hai mươi bốn". Nhóm đúng 3 chữ số sau dấu chấm/phẩy là hàng nghìn (10.000, 1,000), còn lại là thập phân (3,5 -> "ba phẩy năm").
Số điện thoại và mã có số 0 đứng đầu được đọc từng chữ số.

**Từ tiếng Anh** (`src/speech/lang-split.ts`): từ chỉ có chữ cái ASCII mà không phải âm tiết tiếng Việt hợp lệ (electric, logo, YouTube),
từ viết tắt in hoa (CEO, AI) và từ có dấu nháy (it's) được tách riêng và đọc bằng giọng tiếng Anh có sẵn trên máy
(ưu tiên en-US chạy trên máy). Từ viết tắt được đánh vần ("C E O"), trừ những từ đọc nguyên như NASA, COVID.
Câu được xếp hàng thành nhiều đoạn, `end` chỉ báo sau đoạn cuối nên đồng bộ không đổi.
Máy chưa có giọng tiếng Anh thì đọc cả câu bằng giọng Việt như cũ. Có thể tắt trong popup > Nâng cao.
Giới hạn: bộ nhận diện dựa trên chính tả, nên từ tiếng Anh trùng hình với âm tiết Việt không dấu (tin, ban, man) vẫn bị coi là tiếng Việt.

## Bản 0.6.5 - Sửa lỗi đọc lại câu, ưu tiên giọng qua mạng

- Sửa lỗi: đổi bất kỳ cài đặt nào (kéo tốc độ tối đa, ngưỡng câu ngắn, âm lượng, đổi giọng...) giữa lúc đang đọc làm câu vừa đọc xong bị đọc lại từ đầu. Nguyên nhân: cài đặt đổi làm con trỏ câu quay về đoạn đang phát. Giờ đang đọc dở thì giữ nguyên vị trí, cài đặt mới áp dụng từ câu sau. Có test tái hiện lỗi.
- Giọng qua mạng được bật sẵn. Cài đặt cũ (trước bản này) được chuyển sang bật một lần; sau đó tắt lại trong popup thì được tôn trọng. Văn bản bản dịch sẽ được gửi tới dịch vụ giọng nói của trình duyệt khi dùng giọng qua mạng.
- Thứ tự tự chọn giọng Việt: Hoài My, Nam Minh (giọng Online (Natural) của Edge), rồi Microsoft An (trên máy), rồi giọng trên máy khác, cuối cùng giọng qua mạng khác. Giọng bạn chọn tay trong popup luôn được ưu tiên nhất. Tắt giọng qua mạng thì chỉ còn giọng trên máy.

## Bản 0.6.4 - Tốc độ đọc tối đa, hai chế độ đọc từ tiếng Anh

- Popup có thanh kéo "Tốc độ đọc tối đa" (1.1x - 1.7x, mặc định 1.7x): mức giọng đọc được tăng lên khi phải bắt kịp video. Khi không bắt kịp thì giữ trần 1.5x như cũ, trừ khi bạn đặt thấp hơn 1.5x. Đặt thấp thì giọng tự nhiên hơn nhưng dễ bỏ sót câu khi người nói nhanh.
- Nâng cao > "Từ tiếng Anh trong câu" là công tắc hai chế độ, luôn có đúng một chế độ bật: (1) đọc bằng giọng Anh (mặc định), (2) đọc bằng giọng Việt với phiên âm sẵn. Chọn chế độ này thì chế độ kia tự tắt.
- Chế độ giọng Việt phiên âm sẵn các từ thông dụng (YouTube, email, iPhone, electric, AI... thành "diu túp", "i meo", "ai phôn"), liền mạch và không đổi giọng, nhưng cách đọc chỉ gần đúng và chưa nghe thử bằng giọng thật. Thêm từ vào `WORDS` hoặc `ACRONYMS` trong `src/speech/respell.ts`. Từ không có trong danh sách đọc theo vần Việt.
- Thanh kéo "Câu ngắn đọc lướt, không ngắt" (0-12 từ, mặc định 5): câu có số từ bằng hoặc ít hơn mức này bỏ dấu câu để đọc liền, câu dài hơn giữ dấu. Kéo về 0 thì luôn giữ dấu câu.

## Bản 0.6.2 - Sửa quy tắc dấu câu

- Đảo lại quy tắc của 0.6.1 (hiểu ngược): câu dài giữ nguyên dấu câu để đọc mượt; câu ngắn (≤ 5 từ), như "Oh my god. Oh no. Oh no.", bỏ dấu câu để đọc lướt liền mạch. Chỉnh `SHORT_SENTENCE_WORDS` trong `speakable.ts`.

## Bản 0.6.1 - Bớt đổi giọng

- Cụm tiếng Anh chỉ gồm từ mượn quen thuộc (video, internet, online, game...) giữ giọng Việt để khỏi đổi giọng. Thêm từ vào `LOANWORDS` trong `lang-split.ts`.
- Khoảng hở khi đổi giữa giọng Việt và giọng Anh là giới hạn của Web Speech API: mỗi giọng là một utterance riêng, không thể trộn hai giọng trong một utterance.
