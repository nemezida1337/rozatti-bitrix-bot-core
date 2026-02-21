from typing import Optional
import os

from fastapi import FastAPI, Header, HTTPException
from dotenv import load_dotenv

from core.models import CortexRequest, CortexResponse, CortexResult
from flows.lead_sales.flow import run_lead_sales_flow

# Подтягиваем переменные из .env (OPENAI_API_KEY, HF_CORTEX_PORT, HF_CORTEX_TOKEN и т.д.)
load_dotenv()

HF_CORTEX_TOKEN = os.getenv("HF_CORTEX_TOKEN")

app = FastAPI(
    title="HF-CORTEX for Rozatti",
    version="1.0.0",
    description="HF-CORTEX (flow=lead_sales) — Cortex-ядро для Rozatti Bitrix Bot Core",
)


def _extract_bearer(authorization: Optional[str]) -> Optional[str]:
    if not authorization:
        return None
    try:
        parts = authorization.strip().split(" ")
        if len(parts) == 2 and parts[0].lower() == "bearer":
            return parts[1].strip() or None
    except Exception:
        return None
    return None


def _check_token(header_token: Optional[str], authorization: Optional[str]) -> None:
    """
    Простая проверка токена:
    - если HF_CORTEX_TOKEN не задан в .env — пропускаем без проверки;
    - если задан — требуем точного совпадения с заголовком X-HF-CORTEX-TOKEN;
      (для обратной совместимости) принимаем Authorization: Bearer <token>.
    """
    if not HF_CORTEX_TOKEN:
        return

    token = header_token or _extract_bearer(authorization)

    if not token or token != HF_CORTEX_TOKEN:
        raise HTTPException(status_code=401, detail="Invalid or missing HF-CORTEX token")


@app.post("/api/hf-cortex/lead_sales", response_model=CortexResponse)
async def hf_cortex_lead_sales(
    req: CortexRequest,
    x_hf_cortex_token: Optional[str] = Header(default=None),
    authorization: Optional[str] = Header(default=None),
) -> CortexResponse:
    """
    Главный эндпоинт HF-CORTEX для Rozatti (flow=lead_sales).

    Сейчас он:
    - принимает стандартный CortexRequest от Node;
    - дергает run_lead_sales_flow(msg, sessionSnapshot, injected_abcp);
    - возвращает CortexResponse с тем же контрактом, который уже понимает Node.
    """
    # 1. Проверяем токен (если включен)
    _check_token(x_hf_cortex_token, authorization)

    # 2. Валидация flow
    if req.flow and req.flow != "lead_sales":
        raise HTTPException(status_code=400, detail=f"Unsupported flow: {req.flow}")

    payload = req.payload
    if payload is None:
        raise HTTPException(status_code=400, detail="Missing payload in CortexRequest")

    # 3. Достаём msg / sessionSnapshot / injected_abcp / offers из payload
    msg = payload.msg or {}
    session_snapshot = payload.sessionSnapshot or {}
    injected_abcp = payload.injected_abcp
    payload_offers = payload.offers or []

    # 4. Запускаем наш Cortex-поток lead_sales
    try:
        result = run_lead_sales_flow(
            msg=msg,
            session=session_snapshot,
            injected_abcp=injected_abcp,
            payload_offers=payload_offers,
        )
    except Exception:
        result = CortexResult(
            action="reply",
            stage="NEW",
            reply="Сервис временно недоступен, менеджер скоро подключится.",
            need_operator=False,
            oems=[],
            update_lead_fields={},
            client_name=None,
            product_rows=[],
            product_picks=[],
            offers=[],
            chosen_offer_id=None,
            contact_update=None,
            meta={},
            debug={"flow_exception": True},
        )

    # 5. Собираем CortexResponse.
    #    В context оставляем хотя бы sessionSnapshot + то, что Node может захотеть видеть.
    context = {
        "sessionSnapshot": session_snapshot,
        "baseContext": payload.baseContext or {},
        "injected_abcp": injected_abcp,
    }

    resp = CortexResponse(
        ok=True,
        app=req.app or "hf-rozatti-py",
        flow=req.flow or "lead_sales",
        stage=result.stage,
        context=context,
        result=result,
        error=None,
    )

    return resp


if __name__ == "__main__":
    import uvicorn

    host = os.getenv("HF_CORTEX_HOST", "127.0.0.1")
    port = int(os.getenv("HF_CORTEX_PORT", "9000"))

    uvicorn.run(
        "app:app",
        host=host,
        port=port,
        reload=True,
    )
