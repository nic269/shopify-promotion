class CartRemoveButton extends HTMLElement {
  constructor() {
    super();
    this.addEventListener("click", (event) => {
      event.preventDefault();
      const shouldTriggerPromotionHandler = this.dataset.promotionItem !== 'true'
      this.closest("cart-items").updateQuantity(this.dataset.index, 0, undefined, shouldTriggerPromotionHandler);
    });
  }
}

customElements.define("cart-remove-button", CartRemoveButton);

const GQL_URL = "https://gql.anhn-proxy.workers.dev/wavecommerce";
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
            price: ${price / 100},
            compareAtPrice: ${data.price / 100}
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

class CartItems extends HTMLElement {
  constructor() {
    super();

    this.lineItemStatusElement = document.getElementById(
      "shopping-cart-line-item-status"
    );

    this.currentItemCount = Array.from(
      this.querySelectorAll('[name="updates[]"]')
    ).reduce(
      (total, quantityInput) => total + parseInt(quantityInput.value),
      0
    );

    this.debouncedOnChange = debounce((event) => {
      this.onChange(event);
    }, 300);

    this.addEventListener("change", this.debouncedOnChange.bind(this));
    
    this.promotionHandler();
  }

  onChange(event) {
    this.updateQuantity(
      event.target.dataset.index,
      event.target.value,
      document.activeElement.getAttribute("name")
    );
  }

  async promotionHandler() {
    const promotions = window?.promotions || []
    if (promotions.length <= 0) return

    this.enableWholeCartLoading()
    const cartResponse = await fetch('/cart.js', {
      method: 'GET'
    })
    const cartData = await cartResponse.json()

    for (let i = 0; i <= promotions.length - 1; i++) {
      const promotion = promotions[i]
      const isGiftItemInThePool = promotion.productsAppliedPromotion.includes(promotion.productGiftId)
      let giftItemFullInfo = undefined
      let itemsInThePoolTotalAmount = 0
      let promotionAppliedItem = undefined

      cartData.items.forEach((item, idx) => {
        if (item?.properties?._ === promotion.id) {
          promotionAppliedItem = {
            ...item,
            lineIndex: idx + 1,
          }
        }

        if (item.id === promotion.productGiftId) {
          giftItemFullInfo = {
            ...item,
            lineIndex: idx + 1,
          }
        }

        if (promotion.productsAppliedPromotion.includes(item.id)) {
          itemsInThePoolTotalAmount += (item.price * item.quantity / 100)
        }
      })

      if (!promotionAppliedItem && giftItemFullInfo) {
        const promotionDiscountValue = (giftItemFullInfo.price * promotion.discountValue) / 100
        const discountedPrice = giftItemFullInfo.price - promotionDiscountValue
        const totalAmountAfterDiscount = isGiftItemInThePool ? (itemsInThePoolTotalAmount - (promotionDiscountValue / 100)) : itemsInThePoolTotalAmount

        if (totalAmountAfterDiscount >= promotion.spendAmount) {
          const createdItemResponse = await fetch(GQL_URL, {
            method: "POST",
            body: JSON.stringify({
              query: getCreateProductMutation(giftItemFullInfo, discountedPrice),
            }),
          });
          const createdItemData = await createdItemResponse.json()
          const createdItemId = createdItemData.data.productCreate.product.variants.edges[0].node.id.match(/([^\/]+)$/ig)[0]

          await this.addItem(createdItemId, 1, {
            discount: promotion.name,
            _originalPrice: giftItemFullInfo.price,
            _: promotion.id,
          })
          const newQuantity = cartData.items[giftItemFullInfo.lineIndex - 1].quantity - 1
          await this.updateQuantityByKey(giftItemFullInfo.key, newQuantity)

          cartData.items[giftItemFullInfo.lineIndex - 1].quantity = newQuantity
        }
      }

      if (promotionAppliedItem && itemsInThePoolTotalAmount < promotion.spendAmount) {
        this.updateQuantity(promotionAppliedItem.lineIndex, 0)
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
    ];
  }

  async updateQuantity(line, quantity, name, shouldTriggerPromotionHandler = true) {
    this.enableWholeCartLoading();

    const body = JSON.stringify({
      line,
      quantity,
      sections: this.getSectionsToRender().map((section) => section.section),
      sections_url: window.location.pathname,
    });

    try {
      const res = await fetch(`${routes.cart_change_url}`, { ...fetchConfig(), ...{ body } })
      const state = await res.text()
      const parsedState = JSON.parse(state);
        this.classList.toggle("is-empty", parsedState.item_count === 0);
        document
          .getElementById("main-cart-footer")
          ?.classList.toggle("is-empty", parsedState.item_count === 0);

        this.getSectionsToRender().forEach((section) => {
          const elementToReplace =
            document
              .getElementById(section.id)
              .querySelector(section.selector) ||
            document.getElementById(section.id);

          elementToReplace.innerHTML = this.getSectionInnerHTML(
            parsedState.sections[section.section],
            section.selector
          );
        });

        this.updateLiveRegions(line, parsedState.item_count);
        document
          .getElementById(`CartItem-${line}`)
          ?.querySelector(`[name="${name}"]`)
          ?.focus();
        this.disableWholeCartLoading();

        if (shouldTriggerPromotionHandler) {
          await this.promotionHandler()
        }
    } catch (error) {
      this.querySelectorAll(".loading-overlay").forEach((overlay) =>
        overlay.classList.add("hidden")
      );
      document.getElementById("cart-errors").textContent =
        window.cartStrings.error;
      this.disableWholeCartLoading();
    }
  }

  async updateQuantityByKey(key, quantity) {
    const body = JSON.stringify({
      id: key,
      quantity,
      sections: this.getSectionsToRender().map((section) => section.section),
      sections_url: window.location.pathname,
    });

    try {
      const res = await fetch(`${routes.cart_change_url}`, { ...fetchConfig(), ...{ body } })
      const state = await res.text()

      const parsedState = JSON.parse(state);
      this.classList.toggle("is-empty", parsedState.item_count === 0);
      document
        .getElementById("main-cart-footer")
        ?.classList.toggle("is-empty", parsedState.item_count === 0);

      this.getSectionsToRender().forEach((section) => {
        const elementToReplace =
          document
            .getElementById(section.id)
            .querySelector(section.selector) ||
          document.getElementById(section.id);

        elementToReplace.innerHTML = this.getSectionInnerHTML(
          parsedState.sections[section.section],
          section.selector
        );
      });
    } catch (error) {
      this.querySelectorAll(".loading-overlay").forEach((overlay) =>
        overlay.classList.add("hidden")
      );
      document.getElementById("cart-errors").textContent =
        window.cartStrings.error;
    }
  }

  async addItem(id, quantity, props, callback) {
    const body = JSON.stringify({
      id,
      quantity,
      sections: this.getSectionsToRender().map((section) => section.section),
      sections_url: window.location.pathname,
      properties: props,
    });

    try {
      const res = await fetch("/cart/add.js", { ...fetchConfig(), ...{ body } })
      const state = await res.text()

      const parsedState = JSON.parse(state);
        this.classList.toggle("is-empty", parsedState.item_count === 0);
        document
          .getElementById("main-cart-footer")
          ?.classList.toggle("is-empty", parsedState.item_count === 0);

        this.getSectionsToRender().forEach((section) => {
          const elementToReplace =
            document
              .getElementById(section.id)
              .querySelector(section.selector) ||
            document.getElementById(section.id);

          elementToReplace.innerHTML = this.getSectionInnerHTML(
            parsedState.sections[section.section],
            section.selector
          );
        });

        callback?.()
    } catch (err) {
      this.querySelectorAll(".loading-overlay").forEach((overlay) =>
        overlay.classList.add("hidden")
      );
      document.getElementById("cart-errors").textContent =
        window.cartStrings.error;
    }
  }

  updateLiveRegions(line, itemCount) {
    if (this.currentItemCount === itemCount) {
      document
        .getElementById(`Line-item-error-${line}`)
        .querySelector(".cart-item__error-text").innerHTML =
        window.cartStrings.quantityError.replace(
          "[quantity]",
          document.getElementById(`Quantity-${line}`).value
        );
    }

    this.currentItemCount = itemCount;
    this.lineItemStatusElement.setAttribute("aria-hidden", true);

    const cartStatus = document.getElementById("cart-live-region-text");
    cartStatus.setAttribute("aria-hidden", false);

    setTimeout(() => {
      cartStatus.setAttribute("aria-hidden", true);
    }, 1000);
  }

  getSectionInnerHTML(html, selector) {
    return new DOMParser()
      .parseFromString(html, "text/html")
      .querySelector(selector).innerHTML;
  }

  enableLoading(line) {
    document
      .getElementById("main-cart-items")
      .classList.add("cart__items--disabled");
    this.querySelectorAll(".loading-overlay")[line - 1].classList.remove(
      "hidden"
    );
    document.activeElement.blur();
    this.lineItemStatusElement.setAttribute("aria-hidden", false);
  }

  disableLoading() {
    document
      .getElementById("main-cart-items")
      .classList.remove("cart__items--disabled");
  }

  enableWholeCartLoading() {
    document
      .getElementById("main-cart-items")
      ?.classList?.add("cart__items--disabled");
    this.querySelectorAll(".cart-loading-overlay")?.[0]?.classList?.remove(
      "hidden"
    );
  }

  disableWholeCartLoading() {
    document
      .getElementById("main-cart-items")
      ?.classList.remove("cart__items--disabled");

    this.querySelectorAll(".cart-loading-overlay")?.[0]?.classList?.add(
      "hidden"
    );
  }
}

customElements.define("cart-items", CartItems);
