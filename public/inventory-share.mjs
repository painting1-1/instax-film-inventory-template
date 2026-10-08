// The shared image contains film names and box quantities only.
export function filmShareItems(batches, series = '') {
  const grouped = new Map();
  for (const batch of batches) {
    if (batch.product.category !== '相纸' || batch.quantity <= 0 || (series && batch.product.series.toLowerCase() !== series.toLowerCase())) continue;
    const item = grouped.get(batch.product.id) || { product: batch.product, quantity: 0 };
    item.quantity += batch.quantity;
    grouped.set(batch.product.id, item);
  }
  const order = { mini: 0, sq: 1, wide: 2 };
  return [...grouped.values()].sort((a, b) => (order[a.product.series.toLowerCase()] ?? 3) - (order[b.product.series.toLowerCase()] ?? 3) || `${a.product.model}${a.product.spec}`.localeCompare(`${b.product.model}${b.product.spec}`, 'zh-CN'));
}

function loadImage(src) {
  return new Promise(resolve => {
    if (!src) return resolve(null);
    const img = new Image();
    img.crossOrigin = 'anonymous';
    const timer = setTimeout(() => resolve(null), 8000);
    img.onload = () => { clearTimeout(timer); resolve(img); };
    img.onerror = () => { clearTimeout(timer); resolve(null); };
    img.src = src;
  });
}

export async function drawFilmShare(items, { title, name, imageSource }) {
  const width = 1200, columns = 5, margin = 45, cell = 222, rowHeight = 310;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = 155 + Math.ceil(items.length / columns) * rowHeight + 70;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('此浏览器暂不支持图片生成');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, width, canvas.height);
  ctx.textAlign = 'center'; ctx.fillStyle = '#202624';
  ctx.font = 'bold 48px system-ui, sans-serif'; ctx.fillText(title, width / 2, 80);
  const images = await Promise.all(items.map(item => loadImage(imageSource(item.product))));
  let missing = 0;
  for (let i = 0; i < items.length; i++) {
    const item = items[i], x = margin + (i % columns) * cell, y = 145 + Math.floor(i / columns) * rowHeight;
    const img = images[i];
    ctx.strokeStyle = '#eceeeb'; ctx.lineWidth = 2;
    ctx.strokeRect(x + 13, y, 196, 196);
    if (img) {
      const scale = Math.min(184 / img.width, 184 / img.height);
      ctx.drawImage(img, x + cell / 2 - img.width * scale / 2, y + 98 - img.height * scale / 2, img.width * scale, img.height * scale);
    } else {
      missing++;
      ctx.fillStyle = '#eef1ed'; ctx.fillRect(x + 15, y + 2, 192, 192);
      ctx.fillStyle = '#66766d'; ctx.font = '24px system-ui, sans-serif'; ctx.fillText('暂无图片', x + cell / 2, y + 105);
    }
    ctx.fillStyle = '#202624';
    const lines = wrapText(ctx, name(item.product), 205, 26);
    ctx.font = 'bold 26px system-ui, sans-serif';
    lines.forEach((line, n) => ctx.fillText(line, x + cell / 2, y + 231 + n * 31));
    ctx.font = '25px system-ui, sans-serif';
    ctx.fillText(`库存 ${Number(item.quantity.toFixed(3))} 盒`, x + cell / 2, y + 231 + lines.length * 31);
  }
  ctx.fillStyle = '#8c948f'; ctx.font = '20px system-ui, sans-serif'; ctx.textAlign = 'right';
  ctx.fillText('片刻库存', width - margin, canvas.height - 25);
  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('图片过大或生成失败，请按系列选择后重试');
  return { blob, missing };
}

function wrapText(ctx, text, maxWidth, size) {
  ctx.font = `bold ${size}px system-ui, sans-serif`;
  const lines = []; let line = '';
  for (const char of text) {
    if (line && ctx.measureText(line + char).width > maxWidth) { lines.push(line); line = ''; }
    line += char;
  }
  if (line) lines.push(line);
  // Long custom names shrink to two lines rather than overlapping the next row.
  if (lines.length > 2) return [lines[0], lines[1].slice(0, -1) + '…'];
  return lines;
}
