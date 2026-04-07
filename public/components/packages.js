const genAIPackages = [
  { name: "@anthropic-ai/sdk", desc: "Official Anthropic Claude API client" },
  {
    name: "groq-sdk",
    desc: "Groq cloud LLM API client (ultra-fast inference)",
  },
  { name: "@google/generative-ai", desc: "Google Gemini API official client" },
  { name: "cohere-ai", desc: "Cohere API client for generation & embeddings" },
  {
    name: "langchain",
    desc: "LLM orchestration — chains, agents, memory, tools",
  },
  { name: "@langchain/core", desc: "Core LangChain primitives and interfaces" },
  {
    name: "@langchain/langgraph",
    desc: "Stateful multi-actor agent graphs (LangGraph)",
  },
  { name: "@langchain/openai", desc: "LangChain OpenAI integration" },
  { name: "@langchain/anthropic", desc: "LangChain Anthropic integration" },
  { name: "llamaindex", desc: "LlamaIndex data framework for LLM apps" },
  {
    name: "@qdrant/js-client-rest",
    desc: "Qdrant vector search engine REST client",
  },
  { name: "chromadb", desc: "ChromaDB open-source vector store client" },
  {
    name: "faiss-node",
    desc: "FAISS vector similarity search bindings for Node",
  },
  { name: "zod", desc: "TypeScript-first schema validation for tool outputs" },
  { name: "tiktoken", desc: "Token counting for OpenAI models (cl100k, etc.)" },
  { name: "axios", desc: "Promise-based HTTP client for API calls" },
  { name: "uuid", desc: "Generate unique IDs for sessions and messages" },
];

export { genAIPackages };
