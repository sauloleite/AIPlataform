# Datasets

Um arquivo JSONL por caso de uso. Cada linha:

```json
{ "id": "credito-001", "input": "...", "expected": "...", "context": [], "tags": ["credito"] }
```

Regras:

- **Versionado no Git**, para que uma mudanca de dataset apareca em PR. Melhorar
  o numero mudando o dataset e o jeito mais facil de enganar a si mesmo.
- **Sem PII real**, nunca. Use dados sinteticos; para CPF, use valores validos
  pelo digito verificador mas nao atribuidos.
- Amostra de producao so entra **anonimizada** e com aprovacao do DPO.
