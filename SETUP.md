# MiniMart – Setup Guide

Frontend on GitHub Pages, backend on Google Apps Script, data in Google Sheets, screenshots in Google Drive.

## 1. Create the Google Sheet
1. Go to <https://sheets.google.com> and create a new spreadsheet named **MiniMart**.
2. Copy the Spreadsheet ID from the URL: `https://docs.google.com/spreadsheets/d/<THIS_PART>/edit`.
3. Create four tabs with these exact names and header rows (row 1). The script also creates any missing tab or empty header row when you run `initSheets` (step 3).

| Tab | Headers (row 1) |
|---|---|
| Products | `id` `name` `category` `description` `price` `unit` `stock` `imageUrl` `discountPercent` `discountEnds` |
| Orders | `orderId` `timestamp` `username` `name` `phone` `email` `items` `total` `paymentMethod` `screenshotUrl` `status` `savings` |
| Users | `username` `passwordHash` `salt` `createdAt` `lastLogin` `email` |
| Sessions | `token` `username` `expiresAt` |

4. Add products to **Products**, one per row, for example:

| id | name | category | description | price | unit | stock | imageUrl | discountPercent | discountEnds |
|---|---|---|---|---|---|---|---|---|---|
| p1 | Tomatoes | Vegetables | Vine-ripened, picked this morning | 2.50 | kg | 40 | tomatoes.svg | | |
| p2 | Hand-knit wool scarf | Textiles | Soft and warm | 22.00 | piece | 10 | scarf.svg | 30 | 12/31/2026 |

**Everything about your products lives in this sheet.** Add a product by adding a row, change a price, stock level, discount or photo by editing its cell, and remove a product by deleting its row. Reload the website to see the change. Nothing is stored in the website code. To start with samples, run `seedDemoProducts` (step 3).

- **Categories:** the site groups products by `category` (any names you like; blank becomes "Other"). `description` is optional, and `id` must be unique. Columns are matched by header name, so their order doesn’t matter.
- **Images are SVG only.** Put your `.svg` files in the `images` folder next to `index.html`, then type the file name in `imageUrl` (`tomatoes.svg`, or just `tomatoes`). A full `https://…/name.svg` link also works. Any other format, or a blank cell, shows a tinted icon tile instead. The 12 sample SVGs are in `images.zip`.

### Discounts and offers
Put a whole number in `discountPercent` (`20` means 20% off) for any product on sale. The optional `discountEnds` column is the last day of the sale; leave it blank for no end date. When that day passes the product returns to full price by itself. Shoppers see a red badge, the old price crossed out, and their total savings. The server recalculates every price at checkout, so a browser can’t change what it pays. **Orders** records each item’s sale price and a `savings` total.

### Order of products
Products are listed first in, first out: the row at the top of the sheet is listed first, and rows you add at the bottom come last. Discounted items jump to the front in an **Offers** section (also first in, first out), and the remaining items follow, grouped by category. Choosing a category button shows that category with its discounted items first.

## 2. Create the Drive folder
1. In Google Drive create a folder, for example **MiniMart Payments**.
2. Open it and copy the ID from the URL: `https://drive.google.com/drive/folders/<THIS_PART>`.
3. Keep the folder private. Screenshots are owned by your account, so only you can open them.

## 3. Add the backend
1. In the spreadsheet choose **Extensions → Apps Script**.
2. Replace the editor contents with `Code.gs`.
3. Fill in `CONFIG` at the top: `SPREADSHEET_ID`, `DRIVE_FOLDER_ID`, `VENDOR_EMAIL`. Leave the tab names unless you renamed them.
4. Select the function `initSheets` and click **Run**. Approve the permission prompts (Sheets, Drive, Mail). If Google shows "unverified app", choose Advanced → Go to project.
5. Optional: select `seedDemoProducts` and click **Run** to fill the empty Products tab with 12 sample items, five of them on sale.

## 4. Deploy as a Web App
1. Click **Deploy → New deployment → Web app**.
2. Set **Execute as: Me** and **Who has access: Anyone**.
3. Click **Deploy** and copy the Web App URL (ending in `/exec`).
4. After any later change to `Code.gs`, use **Deploy → Manage deployments → Edit → New version**. The URL stays the same.

## 5. Connect the frontend
1. Open `app.js` and set `API_URL` to your Web App URL.
2. Change `CURRENCY` if you don’t use `$`.
3. Save your payment QR image as **`qr.png`** next to `index.html`.

## 6. Publish on GitHub Pages
1. Create a GitHub repository and upload `index.html`, `app.js`, `style.css`, `qr.png` and the `images` folder. Don’t upload `Code.gs` if the repo is public (it is harmless, but your IDs would be exposed).
2. Open **Settings → Pages**, choose **Deploy from a branch**, pick `main` and `/ (root)`, then Save.
3. Your site appears at `https://<username>.github.io/<repo>/` within a minute or two.

## 7. Test everything
1. **Browse:** open the site without logging in. Products appear grouped by category, with a filter bar on top. Add some items to the cart.
2. **Sign up at checkout:** click **Log in to checkout**, enter a new username and password, then press **Login / Sign Up**. The email box appears: enter your email and press the button again. A new row appears in **Users** (hash, salt and email, never the password), and your cart is kept.
3. **Logout:** click **Logout**. The catalog stays visible.
4. **Login:** use the same credentials. `lastLogin` updates.
5. **Wrong password:** use the same username with a different password. You should see "Wrong password".
6. **Forgot password:** click **Forgot password?**, enter the username, then type the 6-digit code from your email plus a new password. You are logged in, and the new password works from then on.
7. **Cash order:** add items, log in, fill in the delivery details, choose Cash on Delivery and place the order. Check the order ID on screen, a **Pending** row in **Orders**, the vendor email, the customer confirmation email, and reduced stock in **Products**.
8. **QR order:** choose QR Code Payment, upload a JPG/PNG screenshot, place the order. Check that the file appears in the Drive folder and that `screenshotUrl` is filled in.

## Troubleshooting
- **"Network error" in the browser:** re-check `API_URL`, and confirm access is **Anyone** and you deployed a **new version** after editing the script.
- **Server error:** in Apps Script open **Executions** to see the logged message.
- **No emails:** emails go to the address saved on the account. Older accounts without one get it saved at their next login, once they fill in the email box. Free Gmail accounts can send about 100 emails a day through Apps Script.
- **Sessions:** a login lasts 24 hours (`SESSION_HOURS`). Five wrong passwords lock that username for 10 minutes.
