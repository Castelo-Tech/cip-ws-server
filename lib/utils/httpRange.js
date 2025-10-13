export function sendBufferWithRange(res, buffer, mimetype, filename, rangeHeader) {
  const size = buffer.length;
  res.setHeader('Content-Type', mimetype);
  res.setHeader('Accept-Ranges', 'bytes');

  if (rangeHeader) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
    if (!m) return res.status(416).end();
    const start = m[1] ? parseInt(m[1], 10) : 0;
    const end   = m[2] ? Math.min(parseInt(m[2], 10), size - 1) : size - 1;
    if (isNaN(start) || isNaN(end) || start > end || start >= size) return res.status(416).end();

    const chunk = buffer.subarray(start, end + 1);
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
    res.setHeader('Content-Length', String(chunk.length));
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(filename)}"`);
    return res.end(chunk);
  }

  res.status(200);
  res.setHeader('Content-Length', String(size));
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(filename)}"`);
  return res.end(buffer);
}
