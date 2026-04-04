import express from "express";
import cors from "cors";
import { Resend } from "resend";
import { execSync } from "child_process";
import fs from "fs";

const app = express();

app.use(cors({
  origin: [
    process.env.FRONTEND_URL || "http://localhost:3000",
    /\.vercel\.app$/,
    /\.onrender\.com$/,
  ],
  credentials: true,
}));

app.use(express.json({ limit: "10mb" }));

function getChromePath(): string {
  // Priority 1: explicit env var set in Render dashboard
  if (process.env.CHROME_EXECUTABLE_PATH && fs.existsSync(process.env.CHROME_EXECUTABLE_PATH)) {
    return process.env.CHROME_EXECUTABLE_PATH;
  }

  // Priority 2: walk the cache directory including the extra chrome/ subfolder
  // Render structure: /opt/render/.cache/puppeteer/chrome/linux-X.X.X/chrome-linux64/chrome
  const baseDirs = [
    process.env.PUPPETEER_CACHE_DIR || "/opt/render/.cache/puppeteer",
    "/root/.cache/puppeteer",
    `${process.env.HOME}/.cache/puppeteer`,
  ];

  for (const base of baseDirs) {
    for (const searchDir of [base, `${base}/chrome`]) {
      if (!fs.existsSync(searchDir)) continue;
      for (const version of fs.readdirSync(searchDir)) {
        const vp = `${searchDir}/${version}`;
        for (const c of [`${vp}/chrome-linux64/chrome`, `${vp}/chrome-linux/chrome`]) {
          if (fs.existsSync(c)) {
            try { execSync(`chmod +x "${c}"`); } catch {}
            console.log("Chrome found at:", c);
            return c;
          }
        }
      }
    }
  }

  throw new Error(`Chrome not found. Set CHROME_EXECUTABLE_PATH env var in Render dashboard.`);
}

async function launchBrowser() {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const puppeteer = require("puppeteer-core");
  const executablePath = getChromePath();
  console.log("Launching Chrome from:", executablePath);

  return puppeteer.launch({
    headless: true,
    executablePath,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--single-process",
      "--no-zygote",
    ],
  });
}

app.get("/health", (_req, res) => {
  let chromePath = "unknown";
  try { chromePath = getChromePath(); } catch (e) { chromePath = String(e); }
  res.json({ status: "ok", chromePath });
});

app.post("/generate-pdf", async (req: any, res: any) => {
  let browser: any = null;
  try {
    const { html, invoiceNumber } = req.body;
    if (!html) return res.status(400).json({ error: "html is required" });

    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle0" });
    await page.emulateMediaType("print");

    const pdfBytes = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "0", bottom: "0", left: "0", right: "0" },
    });

    await browser.close();
    browser = null;

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="invoice-${invoiceNumber ?? "download"}.pdf"`);
    res.setHeader("Cache-Control", "no-store");
    res.send(Buffer.from(pdfBytes));
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    console.error("PDF error:", err);
    res.status(500).json({ error: String(err) });
  }
});

app.post("/send-email", async (req: any, res: any) => {
  let browser: any = null;
  try {
    const { html, invoice, invoiceNumber } = req.body;
    if (!html || !invoice?.client?.email) {
      return res.status(400).json({ error: "html and client email are required" });
    }

    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle0" });
    const pdfBytes = await page.pdf({ format: "A4", printBackground: true });
    await browser.close();
    browser = null;

    const pdfBuffer = Buffer.from(pdfBytes);
    const resend = new Resend(process.env.RESEND_API_KEY);

    const { error } = await resend.emails.send({
      from: `${invoice.business?.name ?? "Invoicely"} <invoices@yourdomain.com>`,
      to: [invoice.client.email],
      subject: `Invoice ${invoiceNumber} from ${invoice.business?.name ?? "Invoicely"}`,
      html: buildEmailHTML(invoice, invoiceNumber),
      attachments: [{ filename: `invoice-${invoiceNumber}.pdf`, content: pdfBuffer }],
    });

    if (error) throw new Error(error.message);
    res.json({ success: true });
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    console.error("Email error:", err);
    res.status(500).json({ error: String(err) });
  }
});

function buildEmailHTML(invoice: Record<string, any>, invoiceNumber: string): string {
  return `
    <div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;color:#1c1a17;">
      <h2 style="font-size:20px;font-weight:600;margin-bottom:8px;">Invoice from ${invoice.business?.name ?? ""}</h2>
      <p style="color:#706a60;font-size:14px;margin-bottom:24px;">Hi ${invoice.client?.name ?? ""}, please find your invoice attached.</p>
      <div style="background:#f8f8f7;border-radius:10px;padding:20px;margin-bottom:24px;">
        <div style="display:flex;justify-content:space-between;margin-bottom:8px;">
          <span style="color:#706a60;font-size:13px;">Invoice Number</span>
          <span style="font-weight:500;font-size:13px;">${invoiceNumber}</span>
        </div>
        <div style="display:flex;justify-content:space-between;">
          <span style="color:#706a60;font-size:13px;">Due Date</span>
          <span style="font-weight:500;font-size:13px;">${invoice.dueDate ?? ""}</span>
        </div>
      </div>
      <p style="color:#a9a39a;font-size:11px;text-align:center;">Sent via Invoicely</p>
    </div>
  `;
}

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Invoiceflow API running on port ${PORT}`);
  // Chrome check on startup — warning only, Chrome is loaded per-request
  try {
    const chromePath = getChromePath();
    console.log(`✓ Chrome ready: ${chromePath}`);
  } catch {
    console.warn("⚠ Chrome not found at startup — will retry on first PDF request.");
    console.warn("  This is normal if the build script runs after server starts.");
  }
});

export default app;
