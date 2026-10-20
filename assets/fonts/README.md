# Font in PDF

NotoSans-Regular.ttf từ kho chính thức Noto Fonts, giấy phép SIL Open Font License 1.1 (OFL.txt).

- Nguồn: https://github.com/notofonts/noto-fonts/blob/main/hinted/ttf/NotoSans/NotoSans-Regular.ttf
- Tải ngày 19/10/2026; SHA-256: `B85C38ECEA8A7CFB39C24E395A4007474FA5A4FC864F6EE33309EB4948D232D5`.
- Font được nhúng subset vào PDF. Giữ cả font và giấy phép trong source/ZIP/deployment.
- Worker đọc `assets/fonts/NotoSans-Regular.ttf` từ thư mục làm việc của repo. Khi triển khai phải mang theo assets, không chỉ dist.
- Có tiếng Việt; không bảo đảm mọi emoji hoặc ngôn ngữ. Render từ chối glyph thiếu để tránh PDF có ô vuông.
