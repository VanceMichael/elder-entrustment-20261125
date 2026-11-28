// 业务应用入口：默认 4318 端口，状态文件 .local/app.json，合作方默认本机 4317。
import { createApp } from './app.mjs';
import { pathToFileURL } from 'node:url';

const stateFile = process.env.APP_STATE ?? '.local/app.json';
const partnerBaseUrl = process.env.PARTNER_URL ?? 'http://127.0.0.1:4317';
const seedFile = process.env.SEED_FILE ?? new URL('../fixtures/records.json', import.meta.url);
const port = Number(process.env.PORT ?? 4318);

const { server } = createApp({ stateFile, partnerBaseUrl, seedFile });
server.listen(port, '0.0.0.0', () => {
  console.log(JSON.stringify({
    message: '养老托付业务应用已启动（本地合成资料，不作真实监护资格或医疗诊断认定）',
    port: server.address().port,
    stateFile,
    partnerBaseUrl,
  }));
});

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // 入口即运行，保留显式判断以便测试中仅导入 createApp。
}
