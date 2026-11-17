// PM2 部署配置
// 启动：pm2 start ecosystem.config.js
// 保存：pm2 save
module.exports = {
  apps: [
    {
      name: 'xhs-order-api',
      script: 'src/app.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork', // Windows 不支持 cluster 模式
      autorestart: true,
      max_memory_restart: '300M',
      kill_timeout: 5000,
      env: {
        NODE_ENV: 'production',
      },
      out_file: './logs/out.log',
      error_file: './logs/error.log',
      merge_logs: true,
      time: true,
    },
  ],
};
