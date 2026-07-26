/**
 * Worker de Cloudflare para el panel de admin de Amigurumis.
 *
 * Secrets/vars que hay que configurar en Cloudflare (Settings > Variables):
 *  - GITHUB_TOKEN   (secret) -> Personal Access Token de GitHub con permiso "Contents: Read and write" sobre el repo
 *  - ADMIN_PASSWORD (secret) -> la contraseña que usará tu madre
 *  - GITHUB_OWNER   (var)    -> tu usuario de GitHub, ej: "SDFanstack"
 *  - GITHUB_REPO    (var)    -> nombre del repo, ej: "amigurumis"
 *  - GITHUB_BRANCH  (var, opcional) -> "main" por defecto
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

function slugify(text) {
  return text
    .toString()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // quita acentos
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

function b64EncodeUnicode(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  bytes.forEach((b) => (binary += String.fromCharCode(b)));
  return btoa(binary);
}

function b64DecodeUnicode(b64) {
  const binary = atob(b64.replace(/\n/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

async function githubContents(env, path, options = {}) {
  const branch = env.GITHUB_BRANCH || 'main';
  const url = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${path}?ref=${branch}`;
  return fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      'User-Agent': 'amigurumis-worker',
      Accept: 'application/vnd.github+json',
      ...(options.headers || {}),
    },
  });
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    if (request.method !== 'POST') {
      return json({ error: 'Método no permitido' }, 405);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'Petición mal formada' }, 400);
    }

    const { password, nombre, descripcion, imagen } = body;

    if (!password || password !== env.ADMIN_PASSWORD) {
      return json({ error: 'Contraseña incorrecta' }, 401);
    }
    if (!nombre || !imagen) {
      return json({ error: 'Falta el nombre o la foto' }, 400);
    }

    try {
      // 1. Preparar la imagen
      const match = imagen.match(/^data:image\/(\w+);base64,(.+)$/);
      if (!match) return json({ error: 'Formato de imagen no válido' }, 400);
      const ext = match[1] === 'jpeg' ? 'jpg' : match[1];
      const imageBase64 = match[2];

      const branch = env.GITHUB_BRANCH || 'main';
      const timestamp = Date.now();
      const filename = `${slugify(nombre)}-${timestamp}.${ext}`;
      const imagePath = `fotos/${filename}`;

      // 2. Subir la imagen al repo
      const uploadImgRes = await githubContents(env, imagePath, {
        method: 'PUT',
        body: JSON.stringify({
          message: `Añadir foto: ${nombre}`,
          content: imageBase64,
          branch,
        }),
      });
      if (!uploadImgRes.ok) {
        const err = await uploadImgRes.text();
        throw new Error('No se pudo subir la foto a GitHub: ' + err);
      }

      // 3. Leer amigurumis.json actual (para conseguir su sha y contenido)
      const getJsonRes = await githubContents(env, 'amigurumis.json');
      if (!getJsonRes.ok) throw new Error('No se pudo leer amigurumis.json');
      const getJsonData = await getJsonRes.json();
      const currentItems = JSON.parse(b64DecodeUnicode(getJsonData.content));

      // 4. Añadir la nueva entrada al principio
      const fecha = new Date().toLocaleDateString('es-ES', {
        day: 'numeric', month: 'long', year: 'numeric',
      });
      currentItems.unshift({
        nombre,
        descripcion: descripcion || '',
        foto: imagePath,
        fecha,
      });

      // 5. Guardar el json actualizado
      const updateJsonRes = await githubContents(env, 'amigurumis.json', {
        method: 'PUT',
        body: JSON.stringify({
          message: `Añadir amigurumi: ${nombre}`,
          content: b64EncodeUnicode(JSON.stringify(currentItems, null, 2)),
          sha: getJsonData.sha,
          branch,
        }),
      });
      if (!updateJsonRes.ok) {
        const err = await updateJsonRes.text();
        throw new Error('No se pudo actualizar amigurumis.json: ' + err);
      }

      return json({ ok: true });
    } catch (e) {
      return json({ error: e.message }, 500);
    }
  },
};
