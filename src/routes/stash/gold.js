const GOLD_API = 'https://register.ylgbullion.co.th/api/price/gold'

export const gold = async ({ db, logger }) => {
  try {
    const response = await fetch(GOLD_API, {
      headers: { 'Accept-Encoding': 'deflate, gzip;q=1.0, *;q=0.5', 'Content-Type': 'application/json; charset=utf-8' },
      method: 'GET',
    })
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`)

    const goldData = await response.json()
    const usdBuy = parseFloat(goldData.exchange_buy) || 33
    const usdSale = parseFloat(goldData.exchange_sale) || 33

    await db
      .insertInto('stash.gold')
      .values({
        tin: goldData.spot.tin.toString(),
        tin_ico: goldData.spot['tin-ico'],
        tout: goldData.spot.tout.toString(),
        tout_ico: goldData.spot['tout-ico'],
        updated_at: new Date(goldData.update_date),
        usd_buy: usdBuy.toString(),
        usd_sale: usdSale.toString(),
      })
      .onConflict((oc) => oc.doNothing())
      .execute()

    return Response.json({
      inserted: {
        tin: goldData.spot.tin,
        tinIco: goldData.spot['tin-ico'],
        tout: goldData.spot.tout,
        toutIco: goldData.spot['tout-ico'],
        updatedAt: goldData.update_date,
        usdBuy,
        usdSale,
      },
      success: true,
    })
  } catch (error) {
    logger.error({ error: error.message }, 'Error fetching gold data')
    return Response.json({ error: error.message, success: false }, { status: 500 })
  }
}
