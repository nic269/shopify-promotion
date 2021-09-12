class CartRemoveButton extends HTMLElement {
  constructor() {
    super()
    this.addEventListener("click", (event) => {
      event.preventDefault()
      const shouldTriggerPromotionHandler = this.dataset.promotionItem !== 'true'
      this.closest("cart-items").updateQuantity({
        line: this.dataset.index,
        quantity: 0,
        shouldTriggerPromotionHandler,
      })
    })
  }
}

customElements.define("cart-remove-button", CartRemoveButton)

const GQL_URL = "https://gql.anhn-proxy.workers.dev/wavecommerce"
const SHOPIFY_PRICE_INDICATOR = 100
const getCreateProductMutation = (data, price) => {
  return `
    mutation ProductCreateMutation {
      productCreate (
        input:{
          handle: "${data.handle}-${new Date().getTime()}",
          title: "${data.title}",
          descriptionHtml: "${data.product_description}",
          images: {
            src: "${data.image}"
          },
          tags: "gift-product-created",
          variants: {
            price: ${price / SHOPIFY_PRICE_INDICATOR},
            compareAtPrice: ${data.price / SHOPIFY_PRICE_INDICATOR}
          },
          status: ACTIVE,
          published: true,
          productType: "Gift Campaign"
        },
      ){
        product {
          id
          variants(first:1){
            edges {
              node{
                id
                price
              }
            }
          }
        }
      }
    }
  `
}
class PromotionServices {
  constructor() {
    this.promotions = window?.promotions || []
  }

  getPromotions() {
    return this.promotions
  }

  async getCartData() {
    try {
      const response = await fetch('/cart.js', {
        method: 'GET'
      })
      const data = await response.json()
  
      return data
    } catch (error) {
      console.error(error)

      return undefined
    }
  }

  getPromotionInfoFromCart(cartData, promotion) {
    let giftProduct = undefined
    let spentAmount = 0
    let giftProductInCart = undefined

    cartData?.items?.forEach?.((item, idx) => {
      if (item?.id === promotion.productGiftId) {
        giftProduct = {
          ...item,
          lineIndex: idx + 1,
        }
      }

      if (item?.properties?._id === promotion.id) {
        giftProductInCart = {
          ...item,
          lineIndex: idx + 1,
        }
      }

      if (promotion.productsAppliedPromotion.includes(item?.id)) {
        const totalItemPrice = item?.price * item?.quantity
        spentAmount += (totalItemPrice / SHOPIFY_PRICE_INDICATOR)
      }
    })

    return {
      giftProduct,
      spentAmount,
      giftProductInCart,
    }
  }

  async createGiftProduct({ giftProduct, discountedPrice }) {
    try {
      const response = await fetch(GQL_URL, {
        method: "POST",
        body: JSON.stringify({
          query: getCreateProductMutation(giftProduct, discountedPrice),
        }),
      })
      const createdItem = await response.json()
      const createdItemId = createdItem?.data?.productCreate?.product?.variants?.edges?.[0]?.node?.id?.match?.(/([^\/]+)$/ig)?.[0]

      return createdItemId
    } catch (error) {
      console.error(error)

      return undefined
    }
  }
}

class CartItems extends HTMLElement {
  constructor() {
    super()

    this.lineItemStatusElement = document.getElementById(
      "shopping-cart-line-item-status"
    )

    this.currentItemCount = Array.from(
      this.querySelectorAll('[name="updates[]"]')
    ).reduce(
      (total, quantityInput) => total + parseInt(quantityInput.value),
      0
    )

    this.debouncedOnChange = debounce((event) => {
      this.onChange(event)
    }, 300)

    this.addEventListener("change", this.debouncedOnChange.bind(this))
    
    this.promotionHandler()
  }

  onChange(event) {
    this.updateQuantity({
      line: event.target.dataset.index,
      quantity: event.target.value,
      name: document.activeElement.getAttribute("name"),
    })
  }

  async promotionHandler() {
    const promotionServices = new PromotionServices()
    const promotions = promotionServices.getPromotions()
    if (promotions.length <= 0) return

    this.enableWholeCartLoading()
    const cartData = await promotionServices.getCartData()

    for (let i = 0; i <= promotions.length - 1; i++) {
      const promotion = promotions[i]
      const isGiftItemInThePool = promotion.productsAppliedPromotion.includes(promotion.productGiftId)
      const {
        giftProduct,
        spentAmount,
        giftProductInCart,
      } = promotionServices.getPromotionInfoFromCart(cartData, promotion)

      if (!giftProductInCart && giftProduct) {
        const promotionDiscountValue = (giftProduct.price * promotion.discountValue) / 100
        const discountedPrice = giftProduct.price - promotionDiscountValue
        const totalAmountAfterDiscountApplied = isGiftItemInThePool ? (spentAmount - (promotionDiscountValue / SHOPIFY_PRICE_INDICATOR)) : spentAmount

        // Handle cart eligibility
        if (totalAmountAfterDiscountApplied >= promotion.spendAmount) {
          const createdItemId = await promotionServices.createGiftProduct({
            giftProduct,
            discountedPrice,
          })

          await this.addItem({
            id: createdItemId,
            quantity: 1,
            properties: {
              discount: promotion.name,
              _originalPrice: giftProduct.price,
              _id: promotion.id,
            }
          })

          // Update gift product 
          const giftProductIndex = giftProduct.lineIndex - 1
          const newQuantity = cartData?.items?.[giftProductIndex]?.quantity - 1
          await this.updateQuantity({
            id: giftProduct.key,
            quantity: newQuantity,
            shouldTriggerPromotionHandler: false
          })
          cartData.items[giftProductIndex].quantity = newQuantity
        }
      }

      // Remove gift product if is in cart and promotion conditions are not matched
      if (giftProductInCart && spentAmount < promotion.spendAmount) {
        this.updateQuantity({
          line: giftProductInCart.lineIndex,
          quantity: 0,
        })
      }
    }

    this.disableWholeCartLoading()
  }

  getSectionsToRender() {
    return [
      {
        id: "main-cart-items",
        section: document.getElementById("main-cart-items").dataset.id,
        selector: ".js-contents",
      },
      {
        id: "cart-icon-bubble",
        section: "cart-icon-bubble",
        selector: ".shopify-section",
      },
      {
        id: "cart-live-region-text",
        section: "cart-live-region-text",
        selector: ".shopify-section",
      },
      {
        id: "main-cart-footer",
        section: document.getElementById("main-cart-footer").dataset.id,
        selector: ".js-contents",
      },
    ]
  }

  async requestCartApi({
    url,
    requestData,
    showLoadingIndicator,
    line,
    name,
  }) {
    if (showLoadingIndicator) this.enableWholeCartLoading()

    try {
      const res = await fetch(url, { ...fetchConfig(), body: requestData })
      const state = await res.text()
      const parsedState = JSON.parse(state)
        this.classList.toggle("is-empty", parsedState.item_count === 0)
        document
          .getElementById("main-cart-footer")
          ?.classList.toggle("is-empty", parsedState.item_count === 0)

        this.getSectionsToRender().forEach((section) => {
          const elementToReplace =
            document
              .getElementById(section.id)
              .querySelector(section.selector) ||
            document.getElementById(section.id)

          elementToReplace.innerHTML = this.getSectionInnerHTML(
            parsedState.sections[section.section],
            section.selector
          )
        })

        if (line && name) {
          this.updateLiveRegions(line, parsedState.item_count)
          document
            .getElementById(`CartItem-${line}`)
            ?.querySelector(`[name="${name}"]`)
            ?.focus()
        }
        
        this.disableWholeCartLoading()
    } catch (error) {
      this.querySelectorAll(".loading-overlay").forEach((overlay) =>
        overlay.classList.add("hidden")
      )
      document.getElementById("cart-errors").textContent =
        window.cartStrings.error
      this.disableWholeCartLoading()
    }
  }

  async updateQuantity({
    id,
    line,
    quantity,
    name,
    shouldTriggerPromotionHandler = true,
  }) {
    const body = JSON.stringify({
      ...(id ? { id } : { line }),
      quantity,
      sections: this.getSectionsToRender().map((section) => section.section),
      sections_url: window.location.pathname,
    })

    await this.requestCartApi({
      url: routes.cart_change_url,
      requestData: body,
      showLoadingIndicator: true,
      line,
      name
    })

    if (shouldTriggerPromotionHandler) {
      await this.promotionHandler()
    }
  }

  async addItem({
    id, quantity, properties,
  }) {
    const body = JSON.stringify({
      id,
      quantity,
      properties,
      sections: this.getSectionsToRender().map((section) => section.section),
      sections_url: window.location.pathname,
    })

    await this.requestCartApi({
      url: '/cart/add.js',
      requestData: body,
      showLoadingIndicator: false,
    })
  }

  updateLiveRegions(line, itemCount) {
    if (this.currentItemCount === itemCount) {
      document
        .getElementById(`Line-item-error-${line}`)
        .querySelector(".cart-item__error-text").innerHTML =
        window.cartStrings.quantityError.replace(
          "[quantity]",
          document.getElementById(`Quantity-${line}`).value
        )
    }

    this.currentItemCount = itemCount
    this.lineItemStatusElement.setAttribute("aria-hidden", true)

    const cartStatus = document.getElementById("cart-live-region-text")
    cartStatus.setAttribute("aria-hidden", false)

    setTimeout(() => {
      cartStatus.setAttribute("aria-hidden", true)
    }, 1000)
  }

  getSectionInnerHTML(html, selector) {
    return new DOMParser()
      .parseFromString(html, "text/html")
      .querySelector(selector).innerHTML
  }

  enableWholeCartLoading() {
    document
      .getElementById("main-cart-items")
      ?.classList?.add("cart__items--disabled")
    this.querySelectorAll(".cart-loading-overlay")?.[0]?.classList?.remove(
      "hidden"
    )
  }

  disableWholeCartLoading() {
    document
      .getElementById("main-cart-items")
      ?.classList.remove("cart__items--disabled")

    this.querySelectorAll(".cart-loading-overlay")?.[0]?.classList?.add(
      "hidden"
    )
  }
}

customElements.define("cart-items", CartItems)
