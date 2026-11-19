import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({plugins:[react()],server:{host:"127.0.0.1",port:Number(process.env.SATS_CHAT_PORT||4405),strictPort:true,proxy:{"/api":process.env.SATS_API_ORIGIN||"http://127.0.0.1:4400"}},build:{outDir:"dist",emptyOutDir:true},base:process.env.SATS_BUILD_BASE||"/"});
