import express from "express";
import cors from "cors";
import puppeteer from "puppeteer";
import { Resend } from "resend";
import path from "path";
import os from "os";

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

// ── Helper: launch browser ────────────────────────────────────────────────────
async function launchBrowser() {
  // On Render, puppeteer downloads Chrome to a known cache path.
  // We resolve it the same way puppeteer does internally.
  const cacheDir =
    process.env.PUPPETEER_CACHE_DIR ||
    path.join(os.homedir(), ".cache", "puppeteer");

  return puppeteer.launch({
    headless: true,
    // Let puppeteer find Chrome automatically from its cache
    executablePath: puppeteer.executablePath(),
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--single-process",          // important for Render's container
      "--no-zygote",               // important for Render's container
    ],
  });
}


// ── server Health check ──────────────────────────────────────────────────────────────


app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    chromePath: puppeteer.executablePath(),
  });
});

// ── PDF Generation ────────────────────────────────────────────────────────────


app.post("/generate-pdf", async (req, res) => {
  let browser = null;
  try {
    const { html, invoiceNumber } = req.body;

    if (!html) {
      return res.status(400).json({ error: "html is required" });
    }

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
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="invoice-${invoiceNumber ?? "download"}.pdf"`
    );
    res.setHeader("Cache-Control", "no-store");
    res.send(Buffer.from(pdfBytes));
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    console.error("PDF error:", err);
    res.status(500).json({ error: String(err) });
  }
});




// ── Send Email ────────────────────────────────────────────────────────────────
app.post("/send-email", async (req, res) => {
  let browser = null;
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
      attachments: [
        {
          filename: `invoice-${invoiceNumber}.pdf`,
          content: pdfBuffer,
        },
      ],
    });

    if (error) throw new Error(error.message);
    res.json({ success: true });
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    console.error("Email error:", err);
    res.status(500).json({ error: String(err) });
  }
});

function buildEmailHTML(
  invoice: Record<string, any>,
  invoiceNumber: string
): string {
  return `
    <div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;color:#1c1a17;">
      <h2 style="font-size:20px;font-weight:600;margin-bottom:8px;">
        Invoice from ${invoice.business?.name ?? ""}
      </h2>
      <p style="color:#706a60;font-size:14px;margin-bottom:24px;">
        Hi ${invoice.client?.name ?? ""}, please find your invoice attached.
      </p>
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
  console.log(`Chrome path: ${puppeteer.executablePath()}`);
});

export default app;