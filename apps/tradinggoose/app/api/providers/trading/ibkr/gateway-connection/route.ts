import { type NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getSession } from '@/lib/auth'
import { createLogger } from '@/lib/logs/console/logger'
import { isTradingServiceError, resolveTradingErrorStatus } from '@/lib/trading/errors'
import { connectIbkrGateway } from '@/lib/trading/ibkr-gateway-connection'

export const dynamic = 'force-dynamic'

const logger = createLogger('IbkrGatewayConnectionRoute')

const RequestSchema = z.object({
  serviceId: z.string().trim().min(1),
})

/**
 * Connects IBKR Paper or Live to the Client Portal Gateway session instead of an
 * OAuth grant, which IBKR only issues to approved third-party vendors.
 */
export async function POST(request: NextRequest) {
  const session = await getSession()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'User not authenticated' }, { status: 401 })
  }

  const parsed = RequestSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ error: 'serviceId is required' }, { status: 400 })
  }

  try {
    const connection = await connectIbkrGateway({
      userId: session.user.id,
      email: session.user.email,
      serviceId: parsed.data.serviceId,
    })
    return NextResponse.json({ success: true, ...connection })
  } catch (error) {
    if (isTradingServiceError(error)) {
      return NextResponse.json(
        { error: error.message },
        { status: resolveTradingErrorStatus(error.status) }
      )
    }
    logger.error('Failed to connect the IBKR gateway', { error })
    return NextResponse.json({ error: 'Failed to connect the IBKR gateway' }, { status: 500 })
  }
}
