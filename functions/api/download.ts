import { parseBucketPath } from "@/utils/bucket";
import { get_auth_status_for_path } from "@/utils/auth";
import { streamZip } from "@/utils/zip";

const MAX_FILES = 500;
const MAX_TOTAL_SIZE = 2 * 1024 * 1024 * 1024;

function badRequest(message: string, status = 400) {
  return new Response(message, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });
}

function safePath(path: string) {
  return !path.startsWith("/") && !path.split(/[\\/]/).some((part) => part === ".." || part === ".");
}

export async function onRequestPost(context) {
  const [bucket] = parseBucketPath(context);
  if (!bucket) return new Response("Not found", { status: 404 });
  if (Number(context.request.headers.get("content-length") || 0) > 1024 * 1024)
    return badRequest("文件列表请求过大", 413);

  let body: { keys?: unknown; prefix?: unknown };
  try {
    if (context.request.headers.get("content-type")?.includes("application/json")) {
      body = await context.request.json();
    } else {
      const form = await context.request.formData();
      body = {
        keys: JSON.parse(String(form.get("keys") || "null")),
        prefix: form.get("prefix"),
      };
    }
  } catch {
    return badRequest("请求内容无效");
  }

  const prefix = typeof body.prefix === "string" ? body.prefix : "";
  const keys = body.keys;
  if (prefix.length > 1024 || !safePath(prefix) || prefix.startsWith("_$flaredrive$/"))
    return badRequest("目录路径无效");
  if (!Array.isArray(keys) || keys.length === 0 || keys.length > MAX_FILES)
    return badRequest(`请选择 1 到 ${MAX_FILES} 个文件`);

  const normalizedPrefix = prefix ? `${prefix.replace(/\/$/, "")}/` : "";
  const uniqueKeys = [...new Set(keys)];
  if (uniqueKeys.length !== keys.length || uniqueKeys.some((key) =>
    typeof key !== "string" || !key.startsWith(normalizedPrefix) || !safePath(key) ||
    key.endsWith("/_$folder$") || key.length > 1024
  )) return badRequest("文件列表包含无效路径");

  for (const key of uniqueKeys) {
    if (!get_auth_status_for_path(context, key)) {
      return new Response("没有下载该目录的权限", { status: 403 });
    }
  }

  const entries = [];
  let totalSize = 0;
  for (const key of uniqueKeys as string[]) {
    const object = await bucket.head(key);
    if (!object) return badRequest(`文件不存在：${key}`, 404);
    if (object.size > MAX_TOTAL_SIZE || totalSize + object.size > MAX_TOTAL_SIZE)
      return badRequest("单次打包总大小不能超过 2 GiB，请分批下载", 413);
    totalSize += object.size;
    const name = key.slice(normalizedPrefix.length);
    if (!name || new TextEncoder().encode(name).length > 65535)
      return badRequest("文件名无效或过长");
    entries.push({ key, name, size: object.size });
  }

  const iterator = streamZip(entries, async (key) => {
    const object = await bucket.get(key);
    if (!object?.body) throw new Error(`无法读取文件：${key}`);
    return object.body;
  });
  const zipStream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await iterator.next();
        if (result.done) controller.close();
        else controller.enqueue(result.value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() {
      await iterator.return();
    },
  });

  const filename = prefix ? `${prefix.replace(/\/$/, "").split("/").pop()}.zip` : "file-library.zip";
  return new Response(zipStream, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
      "Cache-Control": "no-store",
    },
  });
}
