const { chromium } = require("playwright");
const fs = require("fs/promises");

// --- КОНФИГУРАЦИЯ ---
const args = process.argv.slice(2);
const IS_HEADLESS = !args.includes("--headed"); // Если есть флаг --headed, то headless = false
// --------------------

function parsePriceText(priceStr) {
  if (!priceStr) return 0;
  const cleanStr = priceStr
    .replace(/\s/g, "")
    .replace(/&nbsp;/g, "")
    .replace(/₽/g, "")
    .replace(",", ".")
    .trim();
  const num = parseFloat(cleanStr);
  return isNaN(num) ? 0 : num;
}

async function getTotalPages(page) {
  try {
    await page.waitForSelector(".ui-table-pagination__pages-list", {
      timeout: 5000,
    });
    const pages = await page.evaluate(() => {
      const list = document.querySelector(".ui-table-pagination__pages-list");
      if (!list) return 1;
      const links = list.querySelectorAll("a.ui-table-pagination__page-item");
      let maxPage = 1;
      links.forEach((link) => {
        const num = parseInt(link.textContent.trim());
        if (!isNaN(num) && num > maxPage) {
          maxPage = num;
        }
      });
      return maxPage;
    });
    return pages;
  } catch (e) {
    return 1;
  }
}

async function parsePage(page) {
  return await page.evaluate(() => {
    const results = [];
    const container = document.querySelector(".catalog-list__content-product");
    if (!container) return [];

    const cards = container.querySelectorAll(".product-card");

    cards.forEach((card) => {
      try {
        // 1. Название и Ссылка
        const titleLink = card.querySelector("a.product-card-body__title");
        if (!titleLink) return;

        const name = titleLink.textContent.trim();
        const url = titleLink.getAttribute("href");
        const id = url
          .split("/")
          .filter((p) => p)
          .pop();

        // 2. Изображение
        let imageUrl = null;
        const imgEl = card.querySelector(".product-card-image__img");
        if (imgEl) {
          const src = imgEl.getAttribute("src");
          if (src) {
            // Добавляем домен, если ссылка относительная
            imageUrl = src.startsWith("http")
              ? src
              : "https://gorzdrav.org" + src;
          }
        }

        // 3. Цена
        let price = 0;
        const priceEl =
          card.querySelector(".ui-price__price--discount") ||
          card.querySelector(".ui-price__price");
        if (priceEl) {
          price = parseFloat(priceEl.textContent.replace(/\D/g, ""));
        }

        // 4. Старая цена
        let oldPrice = null;
        if (card.hasAttribute("data-original-price")) {
          oldPrice = parseFloat(card.getAttribute("data-original-price"));
        }

        // 5. Производитель и Страна
        let manufacturer = null;
        let country = null;
        card.querySelectorAll(".product-card__item").forEach((item) => {
          const label = item.querySelector(".product-card__label");
          if (label) {
            const labelText = label.textContent.trim();
            const valueEl = item.querySelector(".product-card__value");
            const valueText = valueEl
              ? valueEl.textContent.trim().replace(/,$/, "")
              : null;

            if (labelText.includes("Производитель")) {
              manufacturer = valueText;
            } else if (labelText.includes("Страна")) {
              country = valueText;
            }
          }
        });

        // 6. Рецепт
        const isPrescription = card.textContent.includes("По рецепту");

        // 7. Наличие
        const inStock = card.textContent.includes("Купить");

        results.push({
          id,
          name,
          url: "https://gorzdrav.org" + url,
          imageUrl,
          price,
          priceNoDiscount: oldPrice,
          isPrescription,
          manufacturer,
          country,
          inStock,
        });
      } catch (e) {
        // console.log("Error parsing card inside browser: ", e);
      }
    });

    return results;
  });
}

async function main() {
  console.log("🚀 Gorzdrav Parser");
  console.log(
    `Mode: ${IS_HEADLESS ? "Headless (background)" : "Headed (visible)"}`,
  );

  let browser;
  try {
    // Запуск с попыткой использовать Edge, если не получится - Chromium
    // Если нужно жестко использовать только Edge, оставьте только channel: 'msedge'
    const launchOptions = {
      headless: IS_HEADLESS,
      args: [
        "--disable-gpu",
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-features=TranslateUI",
        "--disable-infobars",
      ],
    };

    // Пытаемся запустить Edge, если доступен
    try {
      browser = await chromium.launch({ ...launchOptions, channel: "msedge" });
      console.log("Browser: Microsoft Edge");
    } catch (e) {
      // Если Edge нет, падаем на стандартный Chromium
      browser = await chromium.launch(launchOptions);
      console.log("Browser: Chromium (Edge not found or error)");
    }
  } catch (e) {
    console.error("✗ Browser failed:", e.message);
    console.error("Run: npx playwright install chromium");
    process.exit(1);
  }

  const allProducts = [];
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 720 },
    locale: "ru-RU",
  });

  try {
    const page = await context.newPage();

    // Блокируем картинки и шрифты для ускорения (если режим headless)
    // В режиме headed можно закомментировать, чтобы видеть картинки
    if (IS_HEADLESS) {
      await page.route(
        "**/*.{png,jpg,jpeg,gif,svg,woff,woff2,ico,mp4,webm}",
        (route) => route.abort(),
      );
    }

    const firstUrl = "https://gorzdrav.org/category/sredstva-ot-diabeta/";
    console.log(`\nFetching first page...`);

    await page.goto(firstUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    await page
      .waitForSelector(".catalog-list__content-product", { timeout: 10000 })
      .catch(() => {});

    const totalPages = await getTotalPages(page);
    console.log(`Total pages found: ${totalPages}`);

    for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
      const url =
        pageNum === 1
          ? firstUrl
          : `https://gorzdrav.org/category/sredstva-ot-diabeta/?page=${pageNum}`;

      console.log(`\n[${pageNum}/${totalPages}] Parsing ${url}`);

      if (pageNum !== 1) {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
        await page
          .waitForSelector(".catalog-list__content-product", { timeout: 10000 })
          .catch(() => {});
      }

      const products = await parsePage(page);
      console.log(`  ✓ Found ${products.length} products`);

      allProducts.push(...products);

      if (pageNum < totalPages) await new Promise((r) => setTimeout(r, 1500));
    }

    await page.close();
  } catch (e) {
    console.error("Critical error:", e.message);
  } finally {
    await context.close();
    await browser.close();
  }

  if (allProducts.length > 0) {
    const unique = Array.from(
      new Map(allProducts.map((p) => [p.id, p])).values(),
    );
    console.log(`\n=== RESULTS ===`);
    console.log(`Total unique products: ${unique.length}`);

    const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    const filename = `gorzdrav_html_${ts}.csv`;

    // Обновленные заголовки с картинкой
    const headers = [
      "ID",
      "Название",
      "Ссылка",
      "Изображение",
      "Цена",
      "ЦенаБезСкидки",
      "Рецептурный",
      "Производитель",
      "Страна",
      "ВНаличии",
    ];
    const lines = [headers.join(";")];

    unique.forEach((p) => {
      const row = [
        p.id,
        `"${(p.name || "").replace(/"/g, '""')}"`,
        p.url,
        p.imageUrl || "",
        p.price,
        p.priceNoDiscount || "",
        p.isPrescription ? "Да" : "Нет",
        `"${(p.manufacturer || "").replace(/"/g, '""')}"`,
        `"${(p.country || "").replace(/"/g, '""')}"`,
        p.inStock ? "Да" : "Нет",
      ];
      lines.push(row.join(";"));
    });

    await fs.writeFile(filename, "\ufeff" + lines.join("\n"), "utf-8");
    console.log(`💾 Saved to ${filename}`);
  } else {
    console.log("\n⚠️ No products found.");
  }
}

main();
