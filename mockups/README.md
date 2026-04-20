# Mockups

UI 探索 — 逆轉裁判 / soco-st 日系風格的 web adapter 前端雛形。

## 開啟

```bash
open mockups/index.html
```

## 素材

`assets/characters/` 裡的 3 張立繪來自 [soco-st.com](https://soco-st.com/)，依授權規約（商用/非商用免費使用於 app/網站/資料等，禁止再配布素材本身、禁止 AI 訓練用途）。

**素材檔未納入 git**（見根目錄 `.gitignore`）。如需重現：

- `host.png` ← `explanation_17484` 系列的 `fukidashi_businessperson_27243_color.png`
- `binbin.png` ← `longing_18919_color.png`
- `huahua.png` ← `fukidashi_businessperson_27262_color.png`

下載後放入 `mockups/assets/characters/` 即可。

## 狀態

純前端 mockup，未接引擎。後續若要接真實 council 對話，需新增 `WebAdapter`（與 `TelegramAdapter` / `CliAdapter` 平行）。
