import { ChatUI } from '../components/ChatUI'

export default function Playground() {
  // TODO: 协议/Provider/Model 选择 + ChatUI（切换协议或模型时清空聊天记录）
  return (
    <div className="flex h-[calc(100vh-3rem)] flex-col">
      <ChatUI />
    </div>
  )
}