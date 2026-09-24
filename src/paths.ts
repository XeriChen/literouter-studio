import path from 'node:path'

/**
 * 数据目录：`GATEWAY_DATA_DIR` 优先，否则取进程当前目录下的 `data`。
 * SQLite 数据库与自动生成的加密密钥文件共用同一解析；测试必须让解析结果落在
 * 系统临时目录内（import 前 `process.chdir(mkdtempSync(...))`，或设置 `GATEWAY_DATA_DIR`）。
 */
export function getDataDir(): string {
  return process.env.GATEWAY_DATA_DIR
    ? path.resolve(process.env.GATEWAY_DATA_DIR)
    : path.resolve(process.cwd(), 'data')
}
