export function productImageSource(image) {
  if (!image) return '';
  return /^data:image\/(?:png|jpeg|webp);base64,/i.test(image) ? image : `/assets/products/${image}`;
}

export async function compressProductImage(file) {
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) throw new Error('请选择 JPG、PNG 或 WebP 图片');
  if (file.size > 20 * 1024 * 1024) throw new Error('图片太大，请选择小于 20 MB 的图片');
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const image = new Image();
      const timer = setTimeout(() => reject(new Error('图片读取超时，请重新选择')), 15000);
      image.onload = () => { clearTimeout(timer); resolve(image); };
      image.onerror = () => { clearTimeout(timer); reject(new Error('无法读取这张图片，请换一张 JPG 或 PNG')); };
      image.src = url;
    });
    const canvas = document.createElement('canvas');
    const scale = Math.min(1, 480 / Math.max(img.naturalWidth, img.naturalHeight));
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('浏览器暂不支持处理图片');
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    for (const quality of [.85, .7, .55, .4]) {
      const data = canvas.toDataURL('image/webp', quality);
      if (data.length <= 42000) return data;
    }
    canvas.width = Math.max(1, Math.round(canvas.width * .65));
    canvas.height = Math.max(1, Math.round(canvas.height * .65));
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const data = canvas.toDataURL('image/jpeg', .6);
    if (data.length > 42000) throw new Error('图片细节过多，请先裁剪商品区域再上传');
    return data;
  } finally { URL.revokeObjectURL(url); }
}
