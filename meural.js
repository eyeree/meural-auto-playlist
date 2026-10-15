class Meural {
  constructor(auth, { fetchImpl = fetch, origin = 'https://api.meural.com/v1', maxPages = 100 } = {}) {
    this.auth = auth; this.fetch = fetchImpl; this.origin = origin; this.maxPages = maxPages;
  }
  async request(method, path, body) {
    let refresh = false, refreshed = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      const token = await this.auth.token(refresh);
      refresh = false;
      if (process.env.MEURAL_DEBUG === '1') console.error(`HTTP ${method} ${path}`);
      let response;
      try { response = await this.fetch(this.origin + path, {
        method, headers: { Authorization: `Token ${token}`, Accept: 'application/json',
          'Content-Type': 'application/json', 'x-meural-api-version': '4', 'x-meural-source-platform': 'web',
          Origin: 'https://my.meural.netgear.com', Referer: 'https://my.meural.netgear.com/', Connection: 'close',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30000), redirect: 'error'
      }); } catch {
        if (method === 'GET' && attempt < 2) { await new Promise(resolve => setTimeout(resolve, 1000)); continue; }
        const error = new Error(`Meural ${method} ${path.split('?')[0]} did not complete; check connectivity or retry later.`);
        error.ambiguous = method !== 'GET';
        throw error;
      }
      if (response.status === 401 && !refreshed && attempt < 2) { refresh = true; refreshed = true; continue; }
      if (method === 'GET' && [408,429,500,502,503,504].includes(response.status) && attempt < 2) {
        const seconds = Number(response.headers?.get('retry-after')) || 1;
        await new Promise(resolve => setTimeout(resolve, Math.min(30000, Math.max(1000, seconds * 1000))));
        continue;
      }
      if (!response.ok) {
        const error = new Error(`Meural ${method} ${path.split('?')[0]} failed (HTTP ${response.status}).`);
        error.status = response.status;
        const detail = await response.text();
        error.insufficientStorage = response.status === 507 || /(?:insufficient|not enough|out of|no more|exceed).{0,60}(?:space|storage|capacity)|(?:space|storage|capacity).{0,60}(?:full|insufficient|exceed)/i.test(detail);
        throw error;
      }
      if (response.status === 204) return {};
      return response.json();
    }
  }
  page(path, page = 1, count = 100) { return this.request('GET', `${path}?page=${page}&count=${count}`); }
  async all(path) {
    const data = [], fingerprints = new Set();
    for (let page = 1; page <= this.maxPages; page++) {
      const response = await this.page(path, page);
      if (!Array.isArray(response.data)) throw new Error(`Expected an array from ${path}.`);
      const fingerprint = JSON.stringify(response.data.map(x => x.id ?? x.post?.id));
      if (response.data.length && fingerprints.has(fingerprint)) throw new Error(`Repeated page from ${path}; refusing incomplete results.`);
      fingerprints.add(fingerprint); data.push(...response.data);
      if (response.isLast === true || (response.data.length === 0 && response.isLast !== false)) return data;
      if (typeof response.isLast !== 'boolean') throw new Error(`Missing pagination metadata from ${path}.`);
    }
    throw new Error(`Pagination limit exceeded for ${path}.`);
  }
  async getData(path) { return (await this.request('GET', path)).data; }
  devices() { return this.all('/user/devices'); }
  galleries() { return this.all('/user/galleries'); }
  gallery(id) { return this.getData(`/galleries/${encodeURIComponent(id)}`); }
  galleryItems(id) { return this.all(`/galleries/${encodeURIComponent(id)}/items`); }
  feedPage(page, count = 100) { return this.page('/feed', page, count); }
  async galleryCreate(name, description, orientation) {
    try { return (await this.request('POST', '/galleries', { name, description, orientation, isPublic: false })).data; }
    catch (error) {
      if (!error.ambiguous) throw error;
      const matches = (await this.galleries()).filter(g => g.name === name);
      if (matches.length !== 1) throw error;
      return matches[0];
    }
  }
  async reconcile(write, verify) {
    try { return await write(); }
    catch (error) {
      if (error.ambiguous && await verify()) return { recovered: true };
      throw error;
    }
  }
  galleryAddItem(gallery, item) {
    return this.reconcile(() => this.request('POST', `/galleries/${gallery}/items/${item}`),
      async () => (await this.galleryItems(gallery)).some(x => String(x.id) === String(item)));
  }
  galleryRemoveItem(gallery, item) {
    return this.reconcile(() => this.request('DELETE', `/galleries/${gallery}/items/${item}`),
      async () => !(await this.galleryItems(gallery)).some(x => String(x.id) === String(item)));
  }
  gallerySort(gallery, order) {
    return this.reconcile(() => this.request('PUT', `/galleries/${gallery}/sort`, { order }),
      async () => JSON.stringify((await this.galleryItems(gallery)).map(x => String(x.id))) === JSON.stringify(order.map(String)));
  }
  deviceAddGallery(device, gallery) {
    return this.reconcile(() => this.request('POST', `/devices/${device}/galleries/${gallery}`),
      async () => (await this.getData(`/devices/${device}`)).galleryIds?.some(id => String(id) === String(gallery)));
  }
  deviceUpdate(device, values) {
    return this.reconcile(() => this.request('PUT', `/devices/${device}`, values), async () => {
      const actual = await this.getData(`/devices/${device}`);
      return Object.entries(values).every(([key, value]) => String(actual[key]) === String(value));
    });
  }
  deviceSync(device) { return this.request('POST', `/devices/${device}/sync`); }
}
module.exports = Meural;
